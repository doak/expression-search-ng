set PATH=c:\Program Files (x86)\7-Zip;c:\Program Files\7-Zip;d:\Program Files (x86)\7-Zip;d:\Program Files\7-Zip
set zip=7z.exe a -tzip -mx1 -r
set AllFiles=api ex-background.js html _locales manifest.json modules scripts skin
del expression-search-ng-v*.xpi
%zip% expression-search-ng-v2.4-beta.xpi %AllFiles% -xr!.svn
