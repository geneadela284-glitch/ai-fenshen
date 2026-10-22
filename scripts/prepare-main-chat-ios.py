from pathlib import Path
import shutil,plistlib,hashlib,json
r=Path(__file__).resolve().parents[1];t=r.parent
base=t.parent/'finance-experience-20261003/AI-Fenshen-finance-b44-renewed.app'
origin=t.parent/'ios-full-restore-20260926/signing-refresh/signing-probe-ios'
out=r/'mobile/ios'
if not out.exists():shutil.copytree(origin,out,symlinks=True)
app=out/'App/App'
old=(origin/'App/App/AppDelegate.swift').read_text();transport=(t.parent/'mobile-20260912/candidate/mobile/transport/MobileTransport.swift').read_text()
assert old.endswith(transport) or old[old.index('import Foundation\nimport UIKit\nimport Capacitor'):].strip()==transport.strip(),'Native source mismatch'
prefix=old[:old.index('import Foundation\nimport UIKit\nimport Capacitor')]
(app/'AppDelegate.swift').write_text(prefix.rstrip()+'\n')
for name in ['MobileTransport.swift','MemoryVault.swift','MemoryAccountScope.swift','MemoryRuntime.swift','MobileMemoryPlugin.swift','memory-runtime.js']:shutil.copy2(r/'mobile/transport'/name,app/name)
shutil.copytree(t/'web-candidate',app/'public',dirs_exist_ok=True)
for name in ['capacitor.config.json','config.xml']:shutil.copy2(base/name,app/name)
info=plistlib.loads((base/'Info.plist').read_bytes())
# Xcode recreates toolchain metadata; retain accepted user-facing localization and permission values.
info={k:v for k,v in info.items() if not k.startswith('DT') and k not in ['BuildMachineOSBuild','CFBundleSupportedPlatforms','MinimumOSVersion']}
info.update(CFBundleExecutable='$(EXECUTABLE_NAME)',CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)',CFBundleName='$(PRODUCT_NAME)',CFBundleVersion='45',AIFenshenMobileRevision='main-chat-unified-build44-base-20261003-b45-r1')
(app/'Info.plist').write_bytes(plistlib.dumps(info,sort_keys=False))
project=out/'App/App.xcodeproj/project.pbxproj';text=project.read_text()
for index,name in enumerate(['MobileTransport.swift','MemoryVault.swift','MemoryAccountScope.swift','MemoryRuntime.swift','MobileMemoryPlugin.swift','memory-runtime.js']):
 fileid=f'AD202610030000000000{index:04d}';buildid=f'AD202610030000000001{index:04d}'
 if fileid in text:continue
 section='Resources' if name.endswith('.js') else 'Sources';kind='sourcecode.javascript' if name.endswith('.js') else 'sourcecode.swift'
 text=text.replace('/* End PBXBuildFile section */',f'\t\t{buildid} /* {name} in {section} */ = {{isa = PBXBuildFile; fileRef = {fileid} /* {name} */; }};\n/* End PBXBuildFile section */')
 text=text.replace('/* End PBXFileReference section */',f'\t\t{fileid} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = {kind}; path = "{name}"; sourceTree = "<group>"; }};\n/* End PBXFileReference section */')
 text=text.replace('504EC3071FED79650016851F /* AppDelegate.swift */,',f'504EC3071FED79650016851F /* AppDelegate.swift */,\n\t\t\t\t{fileid} /* {name} */,',1)
 anchor='504EC3081FED79650016851F /* AppDelegate.swift in Sources */,' if section=='Sources' else '50379B232058CBB4000EE86E /* capacitor.config.json in Resources */,'
 assert anchor in text
 text=text.replace(anchor,anchor+f'\n\t\t\t\t{buildid} /* {name} in {section} */,',1)
project.write_text(text)
report={'nativeSourceOrigin':str(origin),'transportSourceVerifiedAgainst':str(t.parent/'mobile-20260912/candidate/mobile/transport/MobileTransport.swift'),'base':'1.0(44)','candidate':'1.0(45)','nativeMemoryAdded':True,'existingTransportRetainedExceptMemoryOwnerBinding':True,'installed':False}
(t/'evidence/native-project-preparation.json').write_text(json.dumps(report,indent=2))
print('NATIVE_PROJECT_PREPARED')
