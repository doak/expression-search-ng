// Original by Ken Mixter for GMailUI, which is "GMailUI is completely free to use as you wish."
// Opera Wang, 2010/1/15
//  MPL 2.0
//Changes for TB 78+ (c) by Klaus Buecher/opto 2020-2021
"use strict";

var EXPORTED_SYMBOLS = ["ExpressionSearchChrome"];
var { ExtensionParent } = ChromeUtils.import("resource://gre/modules/ExtensionParent.jsm");
var extension = ExtensionParent.GlobalManager.getExtension("expressionsearch@opto.one");

const XULNS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const statusbarIconID = "expression-search-status-bar";
const statusbarIconSrc = 'resource://expressionsearch/skin/statusbar_icon.png';
const popupsetID = "expressionSearch-statusbar-popup";
const contextMenuID = "expression-search-context-menu";
const tooltipId = "expression-search-tooltip";

/* https://bugzilla.mozilla.org/show_bug.cgi?id=1383215#c24
There are two ways that we currently support packaging omnijar:
1) Separate JAR files for toolkit (GRE) content and app-specific content.
2) One JAR file containing both app-specific and toolkit content.

Firefox uses the former (but used to use the latter), and Thunderbird uses the latter.
In case 2, resource:/// and resource://gre/ point to the same place, so it's technically possible to refer to app or toolkit content by two separate URLs,
and it's easy to carelessly use the wrong one. We had a bunch of these issues (especially with add-ons) when we switched layouts.

But the code that's using resource://gre/ URLs for app content, or vice versa, is still technically wrong. */

/*
 * NEXT STEPS FOR CONVERSION:
 *  - remove AOP: hook into the functions directly, or rethink if it is needed,
 *    some actions have been moved to unLoad() and refreshFilterBar() already
 *
 *  - move status bar popup into a action_popup, which should eliminate
 *    ExpressionSearchCommon.jsm and NotifyTools
 *
 *  - migrate prefs to local storage
 *
 *  - once a quicker search is available and there is an API to load a list of
 *    messages into the view (custom search results), add a own, dedicated button
 *    and no longer manipulate the existing quick search button and perform all
 *    actions via API
 */

// for hook functions for attachment search
var { SearchSpec } = ChromeUtils.import("resource:///modules/SearchSpec.jsm");
// general services
var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { MailServices } = ChromeUtils.import("resource:///modules/MailServices.jsm");
var { MailUtils } = ChromeUtils.import("resource:///modules/MailUtils.jsm");
var { clearTimeout, setTimeout } = ChromeUtils.import("resource://gre/modules/Timer.jsm");
var { VirtualFolderHelper } = ChromeUtils.import(
  "resource:///modules/VirtualFolderWrapper.jsm"
);
var { GlodaUtils } = ChromeUtils.import(
  "resource:///modules/gloda/GlodaUtils.jsm"
);

// XXX we need to know whether the gloda indexer is enabled for upsell reasons,
// but this should really just be exposed on the main Gloda public interface.
var { GlodaIndexer } = ChromeUtils.import(
  "resource:///modules/gloda/GlodaIndexer.jsm"
);


var {
  MessageTextFilter,
  QuickFilterManager,
  QuickFilterSearchListener,
  QuickFilterState,
} = ChromeUtils.import("resource:///modules/QuickFilterManager.jsm");
var { ExpressionSearchLog } = ChromeUtils.import("resource://expressionsearch/modules/ExpressionSearchLog.jsm"); // load log first
var {
  ExpressionSearchComputeExpression,
  ExpressionSearchExprToStringInfix,
  ExpressionSearchTokens
} = ChromeUtils.import("resource://expressionsearch/modules/gmailuiParse.jsm");
var { ExpressionSearchAOP } = ChromeUtils.import("resource://expressionsearch/modules/ExpressionSearchAOP.jsm");
var { ExpressionSearchCommon } = ChromeUtils.import("resource://expressionsearch/modules/ExpressionSearchCommon.jsm");

var ExpressionSearchChrome = {
  // if last key is Enter
  isEnter: 0,
  hookedGlobalFunctions: [],
  three_panes: [], // 3pane windows

  needMoveId: "quick-filter-bar-main-bar",
  originalFilterId: "qfb-qs-textbox",
  textBoxDomId: "expression-search-textbox",

  prefs: null, // preference object
  options: {}, // preference strings

  // https://bugzilla.mozilla.org/show_bug.cgi?id=1413413 Remove support for extensions having their own prefs file
  setDefaultPrefs: function () {
    let branch = Services.prefs.getDefaultBranch("");
    let prefLoaderScope = {
      pref: function (key, val) {
        switch (typeof val) {
          case "boolean":
            branch.setBoolPref(key, val);
            break;
          case "number":
            branch.setIntPref(key, val);
            break;
          case "string": // default don't have complex values, only empty or simple strings
            branch.setStringPref(key, val);
            break;
        }
      }
    };
    let uri = Services.io.newURI("resource://expressionsearch/modules/defaults.js");
    try {
      Services.scriptloader.loadSubScript(uri.spec, prefLoaderScope, "UTF-8");

    } catch (err) {
      ExpressionSearchLog.logException(err);
    }
  },

  initPrefs: function () {
    this.setDefaultPrefs();
    this.prefs = Services.prefs.getBranch("extensions.expressionsearch.");
    this.prefs.addObserver("", this, false);
    ["hide_normal_filer", "act_as_normal_filter", "reuse_existing_folder", "load_virtual_folder_in_tab", "select_msg_on_enter", "move2bar", "search_timeout",
      "results_label_size", "showbuttonlabel", "statusbar_info_showtime", "statusbar_info_hidetime", "c2s_enableCtrl", "c2s_enableShift", "c2s_enableCtrlReplace",
      "c2s_enableShiftReplace", "c2s_regexpMatch", "c2s_regexpReplace", "c2s_removeDomainName", "installed_version", "enable_statusbar_info", "enable_verbose_info"].forEach(function (key) {
        try {
          ExpressionSearchChrome.observe('', 'nsPref:changed', key); // we fake one
        } catch (err) {
          ExpressionSearchLog.logException(err);
        }
      });
  },

  cleanupPrefs: function () {
    ExpressionSearchLog.info("ExpressionSearchChrome cleanup");
    this.prefs.removeObserver("", ExpressionSearchChrome);
    this.hookedGlobalFunctions.forEach(hooked => hooked.unweave());
    ExpressionSearchLog.info("Expression Search: cleanup done");
  },

  // get called when event occurs with our perf branch
  observe: function (subject, topic, data) {
    if (topic != "nsPref:changed") {
      return;
    }
    switch (data) {
      case "hide_normal_filer":
      case "act_as_normal_filter":
      case "reuse_existing_folder":
      case "load_virtual_folder_in_tab":
      case "select_msg_on_enter":
      case "c2s_enableCtrl":
      case "c2s_enableShift":
      case "c2s_enableCtrlReplace":
      case "c2s_enableShiftReplace":
      case "c2s_removeDomainName":
      case "enable_statusbar_info":
      case "enable_verbose_info":
        this.options[data] = this.prefs.getBoolPref(data);
        break;
      case "move2bar": // 0:keep, 1:toolbar, 2:menubar 3: tabbar
      case "showbuttonlabel": // 0:auto 1:force show 2:force hide 3:hide label & button
      case "statusbar_info_showtime":
      case "statusbar_info_hidetime":
      case "results_label_size": // 0: hide when on filter bar and vertical layout , 1: show 2: hide
      case "search_timeout":
        this.options[data] = this.prefs.getIntPref(data);
        break;
      case "c2s_regexpMatch":
      case "c2s_regexpReplace":
      case "installed_version":
      case "virtual_folder_path":
        this.options[data] = this.prefs.getStringPref(data);
        break;
      default:
        ExpressionSearchLog.log("Unknown perf key:" + data, "Error", 1);
        break;
    }
    if (data == 'enable_verbose_info') ExpressionSearchLog.setVerbose(this.options.enable_verbose_info);
    if (['hide_normal_filer', 'move2bar', 'showbuttonlabel', 'enable_verbose_info', "results_label_size"].includes(data)) {
      this.three_panes.forEach(win => this.refreshFilterBar(win));
    }

    if (data == 'search_timeout') {
      this.three_panes.forEach(win => this.setSearchTimeout(win));
    }
  },




  initFunctionHook: function (win) {
    if (typeof (win.QuickFilterBarMuxer) == 'undefined' || typeof (win.QuickFilterBarMuxer.reflectFiltererState) == 'undefined') return;

    win._expression_search.hookedFunctions.push(ExpressionSearchAOP.around(
      {
        target: win.QuickFilterBarMuxer,
        method: 'reflectFiltererState'
      },
      function (invocation) {
        let show = (ExpressionSearchChrome.options.move2bar == 0 || !ExpressionSearchChrome.options.hide_normal_filer);
        let hasFilter = typeof (this.maybeActiveFilterer) == 'object';
        let aFilterer = invocation.arguments[0];
        // filter bar not need show, so hide mainbar(in refreshFilterBar) and show quick filter bar
        if (!show && !aFilterer.visible && hasFilter) aFilterer.visible = true;
        return invocation.proceed();
      }
    )[0]);

    // onMakeActive && onTabSwitched: show or hide the buttons & search box
    win._expression_search.hookedFunctions.push(ExpressionSearchAOP.around(
      {
        target: win.QuickFilterBarMuxer,
        method: 'onMakeActive'
      },
      function (invocation) {
        let aFolderDisplay = invocation.arguments[0];
        let tab = aFolderDisplay._tabInfo;
        let appropriate = ("quickFilter" in tab._ext) && aFolderDisplay.displayedFolder && !aFolderDisplay.displayedFolder.isServer;
        win.document.getElementById(ExpressionSearchChrome.needMoveId).style.visibility = appropriate ? 'visible' : 'hidden';
        win.document.getElementById("qfb-results-label").style.visibility = appropriate ? 'visible' : 'hidden';
        return invocation.proceed();
      }
    )[0]);

    win._expression_search.hookedFunctions.push(ExpressionSearchAOP.before({ target: win.QuickFilterBarMuxer, method: 'onTabSwitched' }, function () {
      let filterer = this.maybeActiveFilterer;
      // filterer means if the tab can use quick filter
      // filterer.visible means if the quick search bar is visible
      win.document.getElementById(ExpressionSearchChrome.needMoveId).style.visibility = filterer /*&& filterer.visible*/ ? 'visible' : 'hidden';
      win.document.getElementById("qfb-results-label").style.visibility = filterer /*&& filterer.visible*/ ? 'visible' : 'hidden';
    })[0]);

    // hook _flattenGroupifyTerms to avoid being flatten
    if (!ExpressionSearchChrome.hookedGlobalFunctions.length) {
      ExpressionSearchChrome.hookedGlobalFunctions.push(ExpressionSearchAOP.around(
        {
          target: SearchSpec.prototype,
          method: '_flattenGroupifyTerms'
        },
        function (invocation) {
          let aTerms = invocation.arguments[0];
          let aCloneTerms = invocation.arguments[1];
          let topWin = Services.wm.getMostRecentWindow("mail:3pane");
          let aNode = topWin.document.getElementById(ExpressionSearchChrome.textBoxDomId);
          if (!aNode || !aNode.value) return invocation.proceed();
          let outTerms = aCloneTerms ? [] : aTerms;
          let term;
          if (aCloneTerms) {
            for (term of fixIterator(aTerms, Ci.nsIMsgSearchTerm)) {
              let cloneTerm = this.session.createTerm();
              cloneTerm.attrib = term.attrib;
              cloneTerm.value = term.value;
              cloneTerm.arbitraryHeader = term.arbitraryHeader;
              cloneTerm.hdrProperty = term.hdrProperty;
              cloneTerm.customId = term.customId;
              cloneTerm.op = term.op;
              cloneTerm.booleanAnd = term.booleanAnd;
              cloneTerm.matchAll = term.matchAll;
              cloneTerm.beginsGrouping = term.beginsGrouping;
              cloneTerm.endsGrouping = term.endsGrouping;
              term = cloneTerm;
              outTerms.push(term);
            }
          }
          return outTerms;
        }
      )[0]);
    }

    // for results label to show correct colour by copy filterActive attribute from quick-filter-bar to qfb-results-label, and set colour in overlay.css
    win._expression_search.hookedFunctions.push(ExpressionSearchAOP.after({ target: win.QuickFilterBarMuxer, method: 'reflectFiltererResults' }, function (result) {
      let qfb = win.document.getElementById("quick-filter-bar");
      let resultsLabel = win.document.getElementById("qfb-results-label");
      if (qfb && resultsLabel) {
        resultsLabel.setAttribute("filterActive", qfb.getAttribute("filterActive") || '');
      }
      return result;
    })[0]);

  },

  registerCallback(win) {
    this.three_panes.push(win);
  },

  unLoad: function (win) {
    if (typeof (win._expression_search) == 'undefined') {
      return;
    }

    ExpressionSearchLog.info("ExpressionSearchChrome unLoad() from window");
    let me = ExpressionSearchChrome;
    if (me.helpTimer > 0) {
      clearTimeout(me.helpTimer);
      me.helpTimer = 0;
    }

    let index = me.three_panes.indexOf(win);
    if (index >= 0) me.three_panes.splice(index, 1);
    let threadPane = win.document.getElementById("threadTree");
    if (threadPane && threadPane.RemoveEventListener) {
      threadPane.RemoveEventListener("contextmenu", me.onContextMenu, true);
    }
    win._expression_search.hookedFunctions.forEach(hooked => hooked.unweave());
    let doc = win.document;
    for (let node of win._expression_search.createdElements) {
      if (typeof (node) == 'string') node = doc.getElementById(node);
      if (node) {
        ExpressionSearchLog.info("removed node", (node.id ? node.id : node));
        node.remove();
      }
    }

    win.document.getElementById('qfb-show-filter-bar').hidden = false;
    win.document.getElementById('qfb-qs-textbox').style.display = "";
    delete win._expression_search;
  },

  refreshFilterBar: function (win) {
    let document = win.document;
    let QuickFilterBarMuxer = win.QuickFilterBarMuxer;
    //thunderbird-private-tabmail-buttons
    //  qfb-show-filter-bar  : document.getElementById("qfb-show-filter-bar").checked = aFilterer.visible;

    //quick-filter-bar
    //  quick-filter-bar-main-bar
    //    qfb-sticky qfb-filter-label [quick-filter-bar-collapsible-buttons] [100 results] [search filter]
    //  quick-filter-bar-expando
    //    quick-filter-bar-tab-bar : it's taG bar
    //    quick-filter-bar-filter-text-bar.collapsed=(aFilterValue.text == null);
    //QuickFilterState.visible

    //QuickFilterBarMuxer
    //  onMakeActive for qfb-show-filter-bar visiable
    //  reflectFiltererState for qfb-show-filter-bar checked
    let filterNode = document.getElementById(this.originalFilterId);
    if (filterNode && filterNode.style) {
      filterNode.style.display = this.options.hide_normal_filer ? 'none' : '';
      filterNode.setAttribute('width', this.options.move2bar == 0 ? 100 : 320);
      filterNode.setAttribute('minwidth', this.options.move2bar == 0 ? 80 : 280);
    }
    if (filterNode && ExpressionSearchChrome.options.hide_normal_filer) // hide normal filter, so reset it
      filterNode.value = '';

    // move expression search box along with other buttons to dest position
    if (this.options.move2bar != win._expression_search.savedPosition) {
      win._expression_search.savedPosition = this.options.move2bar;
      let dest = 'quick-filter-bar';
      let qfb = document.getElementById(dest);
      if (this.options.move2bar) qfb.classList.add('resetHeight'); // hide the qfb bar when move the elements to other places
      else qfb.classList.remove('resetHeight');

      let reference = null;
      let showFilterBarButton = document.getElementById('qfb-show-filter-bar');
      if (this.options.move2bar == 0) {
        reference = document.getElementById("quick-filter-bar-expando");
        showFilterBarButton.hidden = false;
      } else if (this.options.move2bar == 1) {
        dest = 'mail-bar3';
        reference = showFilterBarButton;
        showFilterBarButton.hidden = true;
      } else if (this.options.move2bar == 2) {
        dest = 'toolbar-menubar';
        showFilterBarButton.hidden = true;
      } else if (this.options.move2bar == 3) {
        dest = 'tabs-toolbar';
        reference = document.getElementById('tabbar-toolbar');
        showFilterBarButton.hidden = true;
      }
      let toolbar = document.getElementById(dest);
      let needMove = document.getElementById(ExpressionSearchChrome.needMoveId);
      toolbar.insertBefore(needMove.parentNode.removeChild(needMove), reference);
    }

    let spacer = document.getElementById('qfb-filter-bar-spacer');
    if (spacer) {
      spacer.setAttribute('minwidth', 0);
      if (this.options.move2bar == 0) {
        spacer.setAttribute('flex', '2000');
        spacer.style.flex = '2000 1';
      } else {
        spacer.removeAttribute('flex');
        spacer.style.flex = '1 2000 auto';
      }
    }

    let resultsLabel = document.getElementById("qfb-results-label");
    if (resultsLabel) {
      if (typeof (resultsLabel._saved_minWidth) == 'undefined') resultsLabel._saved_minWidth = resultsLabel.getAttribute('minwidth') || 1;
      let layout = Services.prefs.getIntPref("mail.pane_config.dynamic");
      let minWidth = (this.options.results_label_size == 2 || (this.options.results_label_size == 0 && this.options.move2bar == 0 && layout == win.kVerticalMailLayout)) ? 0 : resultsLabel._saved_minWidth;
      resultsLabel.setAttribute('minwidth', minWidth);
      if (minWidth == 0) delete resultsLabel.style.width;
      if (spacer) {
        if (minWidth == 0) spacer.style.width = "1px";
        else spacer.style.width = "15px";
      }
    }

    let collapsible = document.getElementById('quick-filter-bar-collapsible-buttons');
    if (collapsible && collapsible.classList) {
      collapsible.classList.remove("hidelabel");
      collapsible.classList.remove("showlabel");
      collapsible.classList.remove("hideall");
      if (spacer) spacer.classList.remove("hideall");
      if (this.options.showbuttonlabel == 1) {
        collapsible.classList.add("showlabel");
      } else if (this.options.showbuttonlabel == 2) {
        collapsible.classList.add("hidelabel");
      } else if (this.options.showbuttonlabel == 3) {
        collapsible.classList.add("hideall");
        if (spacer) spacer.classList.add("hideall");
      } else if (this.options.showbuttonlabel == 0) {
        // auto show/hide collapsible buttons
        if (QuickFilterBarMuxer._buttonLabelsCollapsed) {
          QuickFilterBarMuxer._minExpandedBarWidth = 0; // let it re-calculate the min expanded bar width because we changed the layout
          QuickFilterBarMuxer.onWindowResize.apply(QuickFilterBarMuxer);
        } else {
          let quickFilterBarBox = document.getElementById("quick-filter-bar-main-bar");
          if (quickFilterBarBox && quickFilterBarBox.clientWidth < quickFilterBarBox.scrollWidth) {
            QuickFilterBarMuxer.onOverflow.apply(QuickFilterBarMuxer);
          }
        }
      }
    }
  },

  hideUpsellPanel: function (win) {
    let panel = win.document.getElementById("qfb-text-search-upsell");
    if (panel.state == "open")
      panel.hidePopup();
  },

  helpTimer: 0,

  showHideHelp: function (win, show, line1, line2, line3, line4) {
    let document = win.document;
    if (typeof (document) == 'undefined' || typeof (document.defaultView) == 'undefined') return;
    let tooltip = document.getElementById(tooltipId);
    let tooltip1 = document.getElementById("expression-search-tooltip-line1");
    let tooltip2 = document.getElementById("expression-search-tooltip-line2");
    let tooltip3 = document.getElementById("expression-search-tooltip-line3");
    let tooltip4 = document.getElementById("expression-search-tooltip-line4");
    let statusbaricon = document.getElementById(statusbarIconID);
    if (tooltip && tooltip1 && tooltip2 && tooltip3 && tooltip4 && statusbaricon) {
      if (typeof (line1) != 'undefined') tooltip1.textContent = line1;
      if (typeof (line2) != 'undefined') tooltip2.textContent = line2;
      if (typeof (line3) != 'undefined') tooltip3.textContent = line3;
      if (typeof (line4) != 'undefined') tooltip4.textContent = line4;
      if (!this.options.enable_statusbar_info) return;
      if (this.helpTimer > 0) {
        clearTimeout(this.helpTimer);
        this.helpTimer = 0;
      }
      let time2hide = this.options['statusbar_info_hidetime'] * 1000;
      if (show) {
        tooltip.openPopup(statusbaricon, "before_start", 0, 0, false, true, null);
        time2hide = this.options['statusbar_info_showtime'] * 1000;
        //if ( this.isFocus ) time2hide *= 2;
      }
      this.helpTimer = setTimeout(function () { tooltip.hidePopup(); }, time2hide);
    }
  },

  onTokenChange: function (event) {
    let searchValue = this.value;
    let start = searchValue.lastIndexOf(' ', this.selectionEnd > 0 ? this.selectionEnd - 1 : 0); // selectionEnd is index of the character after the selection
    //let currentString = searchValue.substring(start+1, this.selectionEnd).replace(/:.*/,'');
    let currentString = searchValue.substring(start + 1).replace(/[ :].*/, '');
    let help = ExpressionSearchTokens.mostFit(currentString);
    let term = undefined;
    if (searchValue == '') term = ' ';
    let win = ExpressionSearchChrome.getWinFromEvent(event);
    ExpressionSearchChrome.showHideHelp(win, 1, help.alias, help.info, help.matchString, term);
  },

  delayedOnSearchKeyPress: function (event) {
    let me = ExpressionSearchChrome;
    let win = ExpressionSearchChrome.getWinFromEvent(event);
    me.isEnter = 0;
    let searchValue = this.value; // this is aNode/my search text box, updated with event.char
    if (event && ((event.code == "return") || (event.code == "enter") || (event.code == "Enter") || (event.code == "NumpadEnter"))) {
      //      if ( event && ( ( event.DOM_VK_RETURN && event.keyCode==event.DOM_VK_RETURN ) || ( event.DOM_VK_ENTER && event.keyCode==event.DOM_VK_ENTER ) ) ) {
      me.isEnter = 1;
      let panel = win.document.getElementById("qfb-text-search-upsell");
      if (typeof (searchValue) != 'undefined' && searchValue != '') {
        let { ExpressionSearchFilter } = ChromeUtils.import("resource://expressionsearch/modules/ExpressionSearchFilter.jsm");
        if (event.ctrlKey || event.metaKey) { // create quick search folder
          ExpressionSearchFilter.latchQSFolderReq = me;
          this._fireCommand(this);
        } else if (GlodaIndexer.enabled && (panel.state == "open" || event.shiftKey || searchValue.toLowerCase().indexOf('g:') == 0)) { // gloda
          searchValue = ExpressionSearchFilter.expression2gloda(searchValue);
          if (searchValue != '') {
            //this._fireCommand(this); // just for selection, but no use as TB will unselect it
            let tabmail = win.document.getElementById("tabmail");
            tabmail.openTab("glodaFacet", {
              searcher: new win.GlodaMsgSearcher(null, searchValue)
            });
          }
        } else {
          let expression = ExpressionSearchComputeExpression(searchValue);
          if (expression.kind == 'spec' && expression.tok == 'calc') {
            me.isEnter = 0; // showCalculationResult also will select the result.
            me.showCalculationResult(win, expression);
          }
        }
      }
    } // end of IsEnter
    me.hideUpsellPanel(win); // hide the panel when key press
    // -- Keypresses for focus transferral
    if (event && (event.code == "ArrowDown") && !event.altKey)
      //    if ( event && event.DOM_VK_DOWN && ( event.keyCode == event.DOM_VK_DOWN ) && !event.altKey )
      me.selectFirstMessage(win, true);
    else if ((typeof (searchValue) == 'undefined' || searchValue == '') && event && (event.code == "Escape") && !event.altKey && !event.ctrlKey)
      //    else if ( ( typeof(searchValue) == 'undefined' || searchValue == '' ) && event && event.DOM_VK_ESCAPE && ( event.keyCode == event.DOM_VK_ESCAPE ) && !event.altKey && !event.ctrlKey )
      me.selectFirstMessage(win); // no select message, but select pane
    //else if (  event.altKey && ( event.ctrlKey || event.metaKey ) && event.keyCode == event.DOM_VK_LEFT ) // Ctrl + <-- not works when focus in textbox
    //  me.back2OriginalFolder(win);
    else me.onTokenChange.apply(this, [event]);
  },

  onSearchKeyPress: function (event) {
    let self = this;
    // defer the call or this.value is still the old value, not updated with event.char yet
    setTimeout(function () { ExpressionSearchChrome.delayedOnSearchKeyPress.call(self, event); }, 0);
  },

  onSearchBarBlur: function (event) {
    let win = ExpressionSearchChrome.getWinFromEvent(event);
    ExpressionSearchChrome.hideUpsellPanel(win);
    ExpressionSearchChrome.isFocus = false;
    ExpressionSearchChrome.showHideHelp(win, false);
  },

  getWinFromEvent: function (event) {
    try {
      return event.view || event.currentTarget.ownerDocument.defaultView;
    } catch (err) {
      ExpressionSearchLog.logException(err);
    }
  },

  onSearchBarFocus: function (event) {
    let win = ExpressionSearchChrome.getWinFromEvent(event);
    let aNode = win.document.getElementById(ExpressionSearchChrome.textBoxDomId);
    if (!aNode) return;
    if (aNode.value == '' && win.QuickFilterBarMuxer) win.QuickFilterBarMuxer._showFilterBar(true);
    ExpressionSearchChrome.isFocus = true;
    ExpressionSearchChrome.onTokenChange.apply(aNode, [event]);
  },

  initSearchInput: function (win) {
    ExpressionSearchLog.info("initSearchInput");
    let doc = win.document;
    let mainBar = doc.getElementById(this.needMoveId);
    let oldTextbox = doc.getElementById(this.originalFilterId);
    if (!mainBar || !oldTextbox) {
      ExpressionSearchLog.log("Expression Search: Can't find quick filter main bar", "Error");
      return;
    }

    //code in moz-central has this without the {is: ...}
    let aNode = doc.createXULElement("search-textbox");//, {is: "search-textbox"});
    // let aNode = oldTextbox.cloneNode();
    aNode.id = this.textBoxDomId;
    aNode.setAttribute("class", "searchBox");
    aNode.setAttribute("type", "search");
    aNode.setAttribute("emptytextbase", extension.localeData.localizeMessage("textbox.emptyText.base"));
    aNode.setAttribute("timeout", 1000);
    aNode.setAttribute("maxlength", 2048);
    aNode.setAttribute("width", 320);
    aNode.setAttribute("maxwidth", 500);
    aNode.setAttribute("minwidth", 280);
    ExpressionSearchLog.info("create box, command", aNode, oldTextbox, oldTextbox._commandHandler)
    // Is the following needed??
    // Currently not:  We create a new searchBox, but we then transfer the UI
    //                 binding of QuickFilterManager to the new field by callling
    //                 _bindUI(). This transfers the key binding of the original
    //                 field to the new field and the #1 in the locale string
    //                 display the current key binding.
    // aNode.onCommand = oldTextbox.onCommand;
    // aNode.setAttribute("keyLabelNonMac", "<Strg-Umschalt-L>");
    // aNode.setAttribute("keyLabelMac", "<L>");

    oldTextbox.parentNode.insertBefore(aNode, oldTextbox.nextSibling);
    win._expression_search.createdElements.push(aNode);

    aNode.addEventListener("keypress", this.onSearchKeyPress, true); // false will be after onComand, too late
    //aNode.addEventListener("keypress", this.onSearchKeyPress, false); // false will be after onComand, too late
    //aNode.addEventListener("input", this.onSearchKeyPress, true); // false will be after onComand, too late
    //aNode.addEventListener("input", this.onTokenChange, true); // input can't get arrow key change but can get update when click2search
    aNode.addEventListener("click", this.onTokenChange, true); // to track selectEnd change
    aNode.addEventListener("blur", this.onSearchBarBlur, true);
    aNode.addEventListener("focus", this.onSearchBarFocus, true);

    // Since we depend on the origibnal field, this is not needed.
    /*
    function handler(aEvent) {
      let filterValues = QuickFilterBarMuxer.activeFilterer.filterValues;
      let preValue =
        latchedFilterDef.name in filterValues
          ? filterValues[latchedFilterDef.name]
          : null;
      let [postValue, update] = latchedFilterDef.onCommand(
        preValue,
        domNode,
        aEvent,
        document
      );
      QuickFilterBarMuxer.activeFilterer.setFilterValue(
        latchedFilterDef.name,
        postValue,
        !update
      );
      if (update) {
        QuickFilterBarMuxer.deferredUpdateSearch();
      }
    };
    aNode.addEventListener("command", handler);
    */

    this.setSearchTimeout(win);
  },

  setSearchTimeout: function (win) {
    let doc = win.document;
    let aNode = doc.getElementById(this.textBoxDomId);
    if (!aNode) return;
    aNode.timeout = this.options.search_timeout || 1000000000;
  },

  back2OriginalFolder: function (win) {
    try {
      if (typeof (win._expression_search.originalURI) == 'undefined') return;
      win.SelectFolder(win._expression_search.originalURI);
    } catch (err) {
    }
  },

  // not works well for complex searchTerms. But it's for all folders.
  createQuickFolder: function (win, searchTerms) {
    let gFolderDisplay = win.gFolderDisplay;
    let currFolder = gFolderDisplay.displayedFolder;
    win._expression_search.originalURI = currFolder.URI;
    let rootFolder = currFolder.rootFolder; // nsIMsgFolder
    let QSFolderName = "ExpressionSearch";
    let searchFolders = [];
    if (!rootFolder) {
      alert('Expression Search: Cannot determine root folder of search');
      return;
    }

    let virtual_folder_path = {};
    try {
      virtual_folder_path = JSON.parse(this.prefs.getStringPref('virtual_folder_path'))
    } catch (ex) {
      // Migrate old values?
    }

    // Get an nsIMsgFolder from the saved WebExtension MailFolder or fall back to the rootfolder
    let targetFolderParent = (virtual_folder_path.accountId)
      ? extension.folderManager.get(virtual_folder_path.accountId, virtual_folder_path.path)
      : rootFolder;

    if (!targetFolderParent) {
      alert('Expression Search: Cannot determine virtual folder path:' + virtual_folder_path);
      return;
    }

    let QSFolderURI = targetFolderParent.URI + "/" + QSFolderName;
    // If there is no ExpressionSearch virtual folder, or if we do not need to honour its searchFolder setting,
    // build a new list of folders to search.
    if (!targetFolderParent.containsChildNamed(QSFolderName) || !this.options.reuse_existing_folder) {
      for (let folder of rootFolder.descendants) {
        // only add non-virtual non-news folders
        if (!folder.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false) && !folder.isSpecialFolder(Ci.nsMsgFolderFlags.Virtual, false)) {
          searchFolders.push(folder.URI);
        }
      }
    }

    // Check if folder exists already.
    if (targetFolderParent.containsChildNamed(QSFolderName)) {
      // modify existing folder
      let msgFolder = MailUtils.getExistingFolder(QSFolderURI);
      if (!msgFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Virtual, false)) {
        alert('Expression Search: Non search folder ' + QSFolderName + ' is in the way');
        return;
      }
      // Prepare the virtual folder for searching.
      let virtualFolderWrapper = VirtualFolderHelper.wrapVirtualFolder(msgFolder);
      virtualFolderWrapper.searchTerms = searchTerms;
      // If reuse_existing_folder is TRUE, do not change its searchFolder setting.
      if (!this.options.reuse_existing_folder) {
        virtualFolderWrapper.searchFolders = searchFolders.join("|");
      }
      virtualFolderWrapper.onlineSearch = false;
      virtualFolderWrapper.cleanUpMessageDatabase();
      MailServices.accounts.saveVirtualFolders();
    } else {
      VirtualFolderHelper.createNewVirtualFolder(QSFolderName, targetFolderParent, searchFolders.join("|"), searchTerms, false);
    }

    if (this.options.load_virtual_folder_in_tab) {
      // Select folders to clear the search box.
      win.SelectFolder(QSFolderURI);
      win.SelectFolder(win._expression_search.originalURI);
      // Do not load the virtual folder directly, as that causes errors, first
      // open the root folder and then return to the virtual folder.
      win.document.getElementById("tabmail").openTab("folder", {
        folder: rootFolder,
      });
    } else {
      if (win._expression_search.originalURI == QSFolderURI) {
        // Select another folder to force reload of our virtual folder.
        win.SelectFolder(rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox).URI);
      }
    }
    win.SelectFolder(QSFolderURI);
  },

  // select first message, expand first container if closed
  selectFirstMessage: function (win, needSelect) { // needSelect: false:no foucus change, undefined:focus pan, true: focus to pan and select message
    if (!win || !win.document) return;
    let doc = win.document;
    let aNode = doc.getElementById(this.textBoxDomId);
    let gFolderDisplay = win.gFolderDisplay;
    if (!aNode || !gFolderDisplay) return;
    if (gFolderDisplay.tree && gFolderDisplay.tree.view) {
      let treeView = gFolderDisplay.tree.view; //nsITreeView
      let dbViewWrapper = gFolderDisplay.view; // DBViewWrapper
      if (treeView && dbViewWrapper && treeView.rowCount > 0) {
        if (treeView.isContainer(0) && !treeView.isContainerOpen(0))
          treeView.toggleOpenState(0);
        if (typeof (needSelect) == 'undefined' || needSelect) {
          let threadPane = doc.getElementById("threadTree");
          // focusing does not actually select the row...
          threadPane.focus();
          if (needSelect) {
            // ...so explicitly select the currentIndex if available or the 1st one
            //threadPane.view.selection.select(threadPane.currentIndex);
            var row = treeView.isContainer(0) && dbViewWrapper.showGroupedBySort ? 1 : 0;
            treeView.selection.select(row);
            gFolderDisplay.tree.ensureRowIsVisible(row);
          } // needSelect
        } // undefined or needSelect
      } // rowCount > 0
    }
    this.isEnter = false;
  },

  calculateResult: function (e) {
    if (e.kind == 'op') {
      if (e.tok == '+' || (e.right != undefined && e.tok == '-') || e.tok == '*' || e.tok == '/') {
        var r1 = this.calculateResult(e.left);
        var r2 = this.calculateResult(e.right);
        if (r1.kind == 'error')
          return r1;
        else if (r2.kind == 'error')
          return r2;
        else {
          if (e.tok == '+')
            return { kind: 'num', tok: r1.tok + r2.tok };
          else if (e.tok == '-')
            return { kind: 'num', tok: r1.tok - r2.tok };
          else if (e.tok == '*')
            return { kind: 'num', tok: r1.tok * r2.tok };
          else if (e.tok == '/') {
            // divide by zero is okay, it just results in infinity
            return { kind: 'num', tok: r1.tok / r2.tok };
          }
        }
      } else if (e.tok == '-') {
        var r1 = calculateResult(e.left);
        if (r1.kind == 'error')
          return r1;
        else
          return { kind: 'num', tok: -r1.tok };
      }
    } else if (e.kind == 'num') {
      return e;
    }
    ExpressionSearchLog.log('Expression Search: unexpected expression tree when calculating result', 1);
    return { kind: 'error', tok: 'internal' };
  },

  showCalculationResult: function (win, expression) {
    let aNode = win.document.getElementById(this.textBoxDomId);
    if (!aNode) return;
    expression = expression.left; // skip the calc: specifier
    // compute the result of this calculation
    var r = this.calculateResult(expression);
    // print the expression,
    var lhs = ExpressionSearchExprToStringInfix(expression);
    var rhs = '' + ((r.kind == 'num') ? r.tok : "<<ERROR: " + r.tok + ">>");
    aNode.value = lhs + " = " + rhs;
    aNode.setSelectionRange(lhs.length, lhs.length + rhs.length + 3); // TODO: not work?
  },

  //Check conditions for search: corresponding modifier is hold on or middle button is pressed
  CheckClickSearchEvent: function (event) {
    // event.button: 0:left, 1:middle, 2:right
    if (event.button != 2) return false;
    if (ExpressionSearchChrome.options.c2s_enableCtrl && event.ctrlKey) return true;
    if (ExpressionSearchChrome.options.c2s_enableShift && event.shiftKey) return true;
    return false;
  },

  //Replace string using user-defined regexp. If not match, return original strings.
  //If multiple matches, return all replaces, concatinated with OR operator
  RegexpReplaceString: function (str) {
    if (ExpressionSearchChrome.options.c2s_regexpMatch.length == 0) return str;
    try {
      let regexp = new RegExp(ExpressionSearchChrome.options.c2s_regexpMatch, "gi"); // with g modifier, r_match[0] is the first match intead of whole match string
      let r_match = str.match(regexp);
      if (!r_match) return str;
      let res = r_match.map(function (match) {
        return match.replace(regexp, ExpressionSearchChrome.options.c2s_regexpReplace);
      });
      let out = res.join(" or ");
      if (res.length > 1)
        out = "(" + out + ")";
      return out;
    } catch (err) {
      ExpressionSearchLog.log("Expression Search Caught Exception " + err.name + ":" + err.message + " with regex '" + ExpressionSearchChrome.options.c2s_regexpMatch + "'", 1);
      return str;
    }
  },

  onContextMenu: function (event) {
    let me = ExpressionSearchChrome;
    let target = event.composedTarget;
    if (!target) return;
    let box = target.parentNode;
    if (!box) return;
    let win = ExpressionSearchChrome.getWinFromEvent(event);
    let aNode = win.document.getElementById(ExpressionSearchChrome.textBoxDomId);
    if (!aNode || !win.gDBView || !win.gFolderDisplay) return;
    if (!me.CheckClickSearchEvent(event)) return;
    let cell = box.getCellAt(event.clientX, event.clientY); // row => 1755, col => { id : 'sizeCol', columns : array }
    let row = cell.row;
    let col = cell.col;
    let token = "";
    let msgHdr = win.gDBView.getMsgHdrAt(row);
    let sCellText = box.view.getCellText(row, col);
    switch (col.id) {
      case "subjectCol":
        if ((me.options.c2s_enableCtrlReplace && event.ctrlKey) || (me.options.c2s_enableShiftReplace && event.shiftKey)) {
          sCellText = me.RegexpReplaceString(sCellText);
        }
        token = "simple";
        if (sCellText.indexOf("(") == 0)
          token = "s";
        let oldValue = "";
        while (oldValue != sCellText) {
          oldValue = sCellText;
          // \uFF1A is Chinese colon
          [/^\s*\S{2,3}(?::|\uFF1A)\s*(.*)$/, /^\s*\[.+\]:*\s*(.*)$/, /^\s+(.*)$/].forEach(function (element, index, array) {
            let newTxt = sCellText.replace(element, '$1');
            if (newTxt != '') sCellText = newTxt;
          });
        }
        break;
      case "senderCol":
        token = "f";
      //no break;
      case "recipientCol":
        if (token == "") token = "t";
      //no break;
      case "sio_inoutaddressCol": //showInOut support
      case "correspondentCol": // https://bugzilla.mozilla.org/show_bug.cgi?id=36489
        if (token == "") { // not recipientCol
          let properties = box.view.getCellProperties(row, col).split(/ +/); // ['incoming', 'imap', 'read', 'replied', 'offline']
          token = (properties.indexOf("in") >= 0 || properties.indexOf("incoming") >= 0) ? "f" : "t";
        }
        // parseMailAddresses needed undecoded option, so can't use mime2DecodedAuthor & mime2DecodedRecipients
        let addressesFromHdr = GlodaUtils.parseMailAddresses(token == 'f' ? msgHdr.author : msgHdr.recipients);
        // sCellText is already decoded, so can't use parseMailAddresses
        let addressesFromCell = MailServices.headerParser.parseDecodedHeader(sCellText);
        sCellText = addressesFromHdr.addresses.map(function (address, index) {
          let ret = address;
          let display = addressesFromCell[index].name;
          if (addressesFromHdr.fullAddresses[index] && display) {
            display = display.replace(/['"<>]/g, '');
            if (addressesFromHdr.fullAddresses[index].toLowerCase().indexOf(display.toLowerCase()) != -1)
              ret = display; // if display name is part of full address, then use display name
          }
          if (!me.options.c2s_removeDomainName) return ret;
          return ret.replace(/(.*)@.*/, '$1'); // use mail ID only if it's an email address and c2s_removeDomainName.
        }).join(' and ');
        if (addressesFromHdr.count > 1) sCellText = "(" + sCellText + ")";
        break;
      case "tagsCol":
        token = "tag";
        sCellText = sCellText.replace(/\s+/g, ' and '); //maybe not correct for "To Do"
        sCellText = "(" + sCellText + ")";
        break;
      case "dateCol":
        token = "date";
        // 5/20/2019, 6:00 PM => 5/20/2019
        // 6:00 PM => 6:00
        sCellText = sCellText.replace(/[,\s]+.*/g, '');
        break;
      default:
        return;
    }
    if (sCellText == "") return;
    win.QuickFilterBarMuxer._showFilterBar(true);
    aNode.value = token + ":" + sCellText;
    aNode.selectionEnd = aNode.selectionStart = 1;
    me.onTokenChange.apply(aNode, [event]);
    me.isEnter = true; // So the email can be selected
    // Stop event bubbling
    event.preventDefault();
    event.stopPropagation();
    aNode._fireCommand(aNode);
    return;
  },

  createKeyset: function (win) {
    let doc = win.document;
    let mailKeys = doc.getElementById('mailKeys');
    if (!mailKeys) return;
    let keyset = doc.createElementNS(XULNS, "keyset");
    keyset.id = 'expression-search-keyset';
    let key1 = doc.createElementNS(XULNS, "key");
    key1.setAttribute("key", extension.localeData.localizeMessage("focusSearch.key"));
    key1.setAttribute("modifiers", extension.localeData.localizeMessage("focusSearch.mod"));
    key1.setAttribute('oncommand', "ExpressionSearchChrome.setFocus(window)");
    let key2 = doc.createElementNS(XULNS, "key");
    key2.setAttribute("keycode", extension.localeData.localizeMessage("back2folder.keycode"));
    key2.setAttribute("modifiers", extension.localeData.localizeMessage("back2folder.mod"));
    key2.setAttribute('oncommand', "ExpressionSearchChrome.back2OriginalFolder(window)");
    keyset.insertBefore(key1, null);
    keyset.insertBefore(key2, null);
    mailKeys.insertBefore(keyset, null);
    win._expression_search.createdElements.push(keyset);
  },

  createTooltip: function (win, status_bar) {
    let doc = win.document;
    ExpressionSearchLog.info("tooltipdoc", doc);
    let tooltip = doc.createElementNS(XULNS, "tooltip");
    tooltip.id = tooltipId;
    tooltip.setAttribute('orient', 'vertical');
    tooltip.setAttribute('style', "white-space: pre-wrap; word-wrap:break-word; max-width: none; overflow: auto; ");
    let classes = ['token', 'info', 'match', 'term'];
    for (let i = 1; i <= 4; i++) {
      let description = doc.createElementNS(XULNS, "description");
      description.id = tooltipId + "-line" + i;
      description.setAttribute('class', 'tooltip-' + classes[i - 1]);
      if (i == 1 || i == 2) {
        description.textContent = extension.localeData.localizeMessage("info.helpLine" + i);
      } else {
        description.textContent = ' ';
      }
      if (i == 2) {
        let hbox = doc.createElementNS(XULNS, "hbox");
        let label = doc.createElementNS(XULNS, "label");
        label.value = "    ";
        description.addEventListener('click', function () { ExpressionSearchCommon.showHelpFile('expressionsearch.helpfile'); });
        hbox.insertBefore(label, null);
        hbox.insertBefore(description, null);
        tooltip.insertBefore(hbox, null);
      } else {
        tooltip.insertBefore(description, null);
      }
    }
    status_bar.insertBefore(tooltip, null);
    win._expression_search.createdElements.push(tooltip);

    // Fix tooltip background color issue on Ubuntu
    if (tooltip && tooltip.classList) {
      let color = win.getComputedStyle(tooltip, null).getPropertyValue("background-color"); // string: rgb(255, 255, 225)
      if (color == 'transparent') tooltip.classList.add("forceInfo");
    }
  },

  initStatusBar: function (win) {
    let doc = win.document;
    let status_bar = doc.getElementById('status-bar');
    if (status_bar) { // add status bar icon
      this.createTooltip(win, status_bar);
      this.createKeyset(win);
      this.createPopup(win); // simple menu popup may can be in statusbarpanel by set that to 'statusbarpanel-menu-iconic', but better not
      let statusbarPanel;
      statusbarPanel = doc.createElementNS(XULNS, "hbox");
      statusbarPanel.classList.add('statusbarpanel');
      let statusbarIcon = doc.createElementNS(XULNS, "image");
      statusbarIcon.id = statusbarIconID;
      statusbarIcon.setAttribute('src', statusbarIconSrc);
      statusbarIcon.setAttribute('tooltip', tooltipId);
      statusbarIcon.setAttribute('popup', contextMenuID);
      statusbarIcon.setAttribute('context', contextMenuID);
      statusbarPanel.insertBefore(statusbarIcon, null);
      status_bar.insertBefore(statusbarPanel, null);
      win._expression_search.createdElements.push(statusbarPanel);
    }
  },

  loadInto3pane: function (win) {
    ExpressionSearchLog.info("loadInto3pane");

    let me = ExpressionSearchChrome;
    try {
      //TODO: What does this do? It messes up the unload and removes the filter bar from the UI, it is
      //      the only function which is using AOP. I looks like this is also handled by events and css.
      //me.initFunctionHook(win);
      me.initStatusBar.apply(me, [win]);


      me.initSearchInput.apply(me, [win]);
      me.refreshFilterBar(win);
      me.registerCallback(win);

      let threadPane = win.document.getElementById("threadTree");
      if (threadPane) {
        // On Mac, contextmenu is fired before onclick, thus even break onclick  still has context menu
        threadPane.addEventListener("contextmenu", me.onContextMenu, true);
      };

      // This only needs to be done once after the first window is loaded, the_bindUI() call
      // also does not seem to be needed for every new window.
      if (!ExpressionSearchChrome.filterAdded) {
        let { ExpressionSearchFilter } = ChromeUtils.import("resource://expressionsearch/modules/ExpressionSearchFilter.jsm");
        QuickFilterManager.defineFilter(ExpressionSearchFilter);
        QuickFilterManager.textBoxDomId = ExpressionSearchFilter.domId;
        ExpressionSearchChrome.filterAdded = true;
        win.QuickFilterBarMuxer._bindUI();
      }
    } catch (ex) {
      ExpressionSearchLog.logException(ex);
    }
  },

  loadIntoVirtualFolderList(win) {
    let me = ExpressionSearchChrome;
    try {
      me.initFolderSelect(win);
      //TODO: What does this do? It messes up the unload and removes the filter bar from the UI, it is
      //      the only function which is using AOP. I looks like this is also handled by events and css.
      //me.initFunctionHook4VirtualFolder(win);
    } catch (ex) {
      ExpressionSearchLog.logException(ex);
    }
  },

  Load: function (win) {
    let type = win.document.documentElement.getAttribute('windowtype');
    if (!["mail:3pane", "mailnews:virtualFolderList"].includes(type)) {
      return;
    }
    if (typeof (win._expression_search) != 'undefined') {
      return ExpressionSearchLog.log("expression search already loaded, return");
    }

    ExpressionSearchLog.info("Start Load() into new window");
    win._expression_search = {
      createdElements: [],
      hookedFunctions: [],
      savedPosition: 0,
      timer: Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer),
      originalURI: undefined
    };

    if (type == 'mail:3pane') {
      ExpressionSearchChrome.loadInto3pane(win);
    } else if (type == 'mailnews:virtualFolderList') {
      ExpressionSearchChrome.loadIntoVirtualFolderList(win);
    }
  },

  setFocus: function (win) {
    if (ExpressionSearchChrome.options.move2bar == 0 && !QuickFilterBarMuxer.activeFilterer.visible)
      QuickFilterBarMuxer._showFilterBar(true);
    let aNode = win.document.getElementById(this.textBoxDomId);
    if (aNode) aNode.focus();
  },

  addMenuItem: function (menu, doc, parent) {
    let item = doc.createElementNS(XULNS, "menuitem");
    item.setAttribute('label', menu[0]);
    if (menu[1]) item.setAttribute('image', menu[1]);
    if (typeof (menu[2]) == 'function') item.addEventListener('command', menu[2], false);
    if (menu[3]) {
      for (let attr in menu[3]) {
        item.setAttribute(attr, menu[3][attr]);
      }
    }
    item.setAttribute('class', "menuitem-iconic");
    parent.insertBefore(item, null);
  },

  createPopup: function (aWindow) {
    let doc = aWindow.document;
    let popupset = doc.createElementNS(XULNS, "popupset");
    popupset.id = popupsetID;
    let menupopup = doc.createElementNS(XULNS, "menupopup");
    menupopup.id = contextMenuID;
    [
      [extension.localeData.localizeMessage("dialog.settings"), "chrome://global/skin/icons/settings.svg", function () { ExpressionSearchCommon.openWindow('/html/esPrefDialog.html'); }],
      [extension.localeData.localizeMessage("option.help"), "resource://expressionsearch/skin/help.png", function () { ExpressionSearchCommon.showHelpFile('expressionsearch.helpfile'); }],
      [extension.localeData.localizeMessage("donate.label"), "resource://expressionsearch/" + extension.localeData.localizeMessage("donate.image"), function () { ExpressionSearchCommon.openLinkExternally("https://www.paypal.com/donate?hosted_button_id=EMVA9S5N54UEW"); }],
      ["Report Bug", "resource://expressionsearch/skin/information.png", function () { ExpressionSearchCommon.openLinkExternally("https://github.com/opto/expression-search-NG/issues"); }],
      [extension.localeData.localizeMessage("about.about"), "resource://expressionsearch/skin/statusbar_icon.png", function () { ExpressionSearchCommon.openWindow("/html/about.html", "", { type: "popup", width: 470, height: 310 }); }],
    ].forEach(function (menu) {
      ExpressionSearchChrome.addMenuItem(menu, doc, menupopup);
    });
    popupset.insertBefore(menupopup, null);
    doc.documentElement.insertBefore(popupset, null);
    aWindow._expression_search.createdElements.push(popupsetID);
  },

  // for VirtualFolder select dialog
  initFolderSelect: function (win) {
    let doc = win.document;
    let folderPickerTree = doc.getElementById('folderPickerTree');
    if (!folderPickerTree) {
      ExpressionSearchLog.log("Expression Search: Can't find folderPickerTree", "Error");
      return;
    }

    let selectall = doc.createElementNS(XULNS, "button");
    selectall.setAttribute("label", extension.localeData.localizeMessage("virtualfolder.selectall"));
    selectall.setAttribute('oncommand', "ExpressionSearchChrome.changeAllFolder(window, true);");

    let clearall = doc.createElementNS(XULNS, "button");
    clearall.setAttribute("label", extension.localeData.localizeMessage("virtualfolder.clearall"));
    clearall.setAttribute('oncommand', "ExpressionSearchChrome.changeAllFolder(window, false);");

    let mode = doc.createElementNS(XULNS, "label");
    mode.setAttribute("value", extension.localeData.localizeMessage('virtualfolder.modelabel'));

    let menulist = doc.createElementNS(XULNS, "menulist");
    menulist.id = 'esFolderType';

    let modesingle = doc.createElementNS(XULNS, "menuitem");
    modesingle.setAttribute("label", extension.localeData.localizeMessage("virtualfolder.modesingle"));
    modesingle.setAttribute("value", 0);

    let modechild = doc.createElementNS(XULNS, "menuitem");
    modechild.setAttribute("label", extension.localeData.localizeMessage("virtualfolder.modechild"));
    modechild.setAttribute("value", 1);

    let modedescendants = doc.createElementNS(XULNS, "menuitem");
    modedescendants.setAttribute("label", extension.localeData.localizeMessage("virtualfolder.modedescendants"));
    modedescendants.setAttribute("value", 2);

    let menupopup = doc.createElementNS(XULNS, "menupopup");
    menupopup.insertBefore(modesingle, null);
    menupopup.insertBefore(modechild, null);
    menupopup.insertBefore(modedescendants, null);
    menulist.insertBefore(menupopup, null);

    let hbox = doc.createElementNS(XULNS, "hbox");
    hbox.setAttribute("align", "center");
    hbox.insertBefore(selectall, null);
    hbox.insertBefore(clearall, null);
    hbox.insertBefore(mode, null);
    hbox.insertBefore(menulist, null);

    folderPickerTree.parentNode.insertBefore(hbox, folderPickerTree);
    win._expression_search.createdElements.push(hbox);
  },

  initFunctionHook4VirtualFolder: function (win) {
    if (typeof (win.gSelectVirtual) == 'undefined' || typeof (win.gFolderTreeView) == 'undefined') return;
    try {
      // How to deal with multi select and reverse?
      win._expression_search.hookedFunctions.push(ExpressionSearchAOP.around({ target: win.gSelectVirtual, method: '_toggle' }, function (invocation) {
        let result = invocation.proceed(); // change folder's state first
        let typeSel = win.document.getElementById('esFolderType');
        let aRow = invocation.arguments[0];
        let folder = win.gFolderTreeView._rowMap[aRow]._folder;
        if (!typeSel || typeSel.value == 0 || !folder) return result;
        ExpressionSearchChrome.changeSubFolder(win, typeSel.value, folder);
        win.gFolderTreeView._tree.invalidate();
        return result;
      })[0]);
    } catch (err) {
      ExpressionSearchLog.logException(err);
    }
  },

  changeSubFolder: function (win, type, folder) {
    try {
      for (let child of folder.subFolders) {
        ExpressionSearchChrome.setFolderSelected(win, child, folder);
        if (type == 2 && child.hasSubFolders && child.numSubFolders > 0) {
          ExpressionSearchChrome.changeSubFolder(win, type, child);
        }
      }
    } catch (err) {
      ExpressionSearchLog.logException(err);
    }
  },

  changeAllFolder: function (win, state) {
    try {
      let accounts = MailServices.accounts.accounts;
      for (let account of accounts) {
        ExpressionSearchChrome.setFolderSelected(win, account.incomingServer.rootFolder, 0, state);
        ExpressionSearchChrome.changeSubFolder(win, 2, account.incomingServer.rootFolder);
        win.gFolderTreeView._tree.invalidate();
      }
    } catch (err) {
      ExpressionSearchLog.logException(err);
    }
  },

  setFolderSelected: function (win, folder, refFolder, state) {
    if (typeof (state) == 'undefined') {
      state = refFolder.inVFEditSearchScope || win.gSelectVirtual._selectedList.has(refFolder);
    }
    if (folder.setInVFEditSearchScope) { // < TB59
      folder.setInVFEditSearchScope(state, false /* subscope, not implemented */);
    } else {
      let selectedList = win.gSelectVirtual._selectedList;
      let selected = selectedList.has(folder);
      if (selected != state) {
        if (selectedList.has(folder))
          selectedList.delete(folder);
        else
          selectedList.add(folder);
      }
    }
  }

};
