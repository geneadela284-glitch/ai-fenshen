from pathlib import Path
import hashlib,json,plistlib,re,shutil,subprocess
r=Path(__file__).resolve().parents[1];t=r.parent
base=t.parent/'finance-experience-20261003/AI-Fenshen-finance-b44-renewed.app'
built=t/'native-build/Build/Products/Debug-iphoneos/App.app'
out=t/'AI-Fenshen-main-chat-b45-candidate.app'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def manifest(root):return {str(p.relative_to(root)):digest(p) for p in root.rglob('*') if p.is_file()}
expected=json.loads((t.parent/'finance-experience-20261003/evidence/renewed-package-manifest.json').read_text());assert manifest(base)==expected
assert not out.exists(),'Do not overwrite an existing package'
profile=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(base/'embedded.mobileprovision')]))
display=subprocess.run(['codesign','-d','--entitlements','-',str(base)],check=True,capture_output=True,text=True)
raw=display.stdout+display.stderr
keys=re.findall(r'\[Key\] (.+)',raw);assert sorted(keys)==sorted(['application-identifier','com.apple.developer.team-identifier','get-task-allow'])
entitlements={'application-identifier':'CU7KCK45UV.com.aifenshen.mobilecompat','com.apple.developer.team-identifier':'CU7KCK45UV','get-task-allow':True}
for k,v in entitlements.items():assert profile['Entitlements'][k]==v
assert all(str(v) in raw for v in entitlements.values() if isinstance(v,str))
ent=t/'evidence/candidate-entitlements.plist';ent.write_bytes(plistlib.dumps(entitlements))
shutil.copytree(base,out,symlinks=True)
for name in ['App','App.debug.dylib','__preview.dylib','memory-runtime.js']:shutil.copy2(built/name,out/name)
shutil.copytree(t/'web-candidate',out/'public',dirs_exist_ok=True)
info=plistlib.loads((out/'Info.plist').read_bytes());info['CFBundleVersion']='45';info['AIFenshenMobileRevision']='main-chat-unified-build44-base-20261003-b45-r1';(out/'Info.plist').write_bytes(plistlib.dumps(info))
identity='7B15BDE14C68B824AC220C12D5A974AD7F1A53AD'
for name in ['App.debug.dylib','__preview.dylib']:subprocess.run(['codesign','--force','--sign',identity,str(out/name)],check=True)
subprocess.run(['codesign','--force','--sign',identity,'--entitlements',str(ent),'--generate-entitlement-der',str(out)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(out)],check=True)
assert manifest(base)==expected
actual=manifest(out);changed=sorted(k for k,v in expected.items() if actual.get(k)!=v)
allowed={'App','App.debug.dylib','__preview.dylib','Info.plist','_CodeSignature/CodeResources','public/index.html','public/assets/AIFenshenRealApp-CEcskaaC.js'}
assert set(changed)<=allowed,changed
assert {k:v for k,v in expected.items() if k.startswith('Frameworks/')}=={k:v for k,v in actual.items() if k.startswith('Frameworks/')}
(t/'evidence/candidate-package-manifest.json').write_text(json.dumps(actual,indent=2))
report={'version':'1.0(45)','revision':info['AIFenshenMobileRevision'],'base':'1.0(44)','baseFilesVerified':len(expected),'baseUnchanged':True,'changedBaseFiles':changed,'addedFiles':sorted(set(actual)-set(expected)),'signatureStrictlyVerified':True,'profileExpiryUTC':profile['ExpirationDate'].isoformat()+'Z','nativeImplementationChanged':'local Memory V2 plugin and authenticated owner binding','frameworksUnchanged':True,'installed':False,'deployed':False}
(t/'evidence/candidate-package-integrity.json').write_text(json.dumps(report,indent=2));print('CANDIDATE_PACKAGE_VERIFIED',len(actual),'files')
