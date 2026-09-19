import * as THREE from '/host/three.module.min.js';
import {tileArt} from '/host/tile-art.js';
import {loadTileFaces} from '/host/tile-textures.js';

// Real geometry, lighting and shadows. No game rules or hidden tiles are read here.
export async function createThreeScene(root){
 const arena=root.querySelector('.arena'),rack=root.querySelector('.hand-rack');
 const tableCanvas=document.createElement('canvas'),handCanvas=document.createElement('canvas');tableCanvas.className='table-3d';handCanvas.className='hand-3d';arena.prepend(tableCanvas);root.querySelector('.hand-area').prepend(handCanvas);
 const renderers=[];const resources=new Set();let disposed=false,frame=0,previous=0,model=null,selectedSlot=null;
 const track=x=>(resources.add(x),x);
 function makeRenderer(canvas){const r=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});r.setPixelRatio(Math.min(devicePixelRatio,1.7));r.outputColorSpace=THREE.SRGBColorSpace;r.toneMapping=THREE.ACESFilmicToneMapping;r.toneMappingExposure=1.0;r.shadowMap.enabled=true;r.shadowMap.type=THREE.PCFSoftShadowMap;renderers.push(r);return r;}
 let tableRenderer,handRenderer;
 try{tableRenderer=makeRenderer(tableCanvas);handRenderer=makeRenderer(handCanvas);handRenderer.toneMapping=THREE.NoToneMapping;handRenderer.toneMappingExposure=1;}catch(error){for(const r of renderers)r.dispose();tableCanvas.remove();handCanvas.remove();throw error;}
 const tableScene=new THREE.Scene(),handScene=new THREE.Scene();
 function lights(scene){scene.add(new THREE.HemisphereLight(0xfff8eb,0x5b6e65,1.7));const key=new THREE.DirectionalLight(0xffeed4,2.0);key.position.set(-5,10,8);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-14;key.shadow.camera.right=14;key.shadow.camera.top=14;key.shadow.camera.bottom=-14;key.shadow.normalBias=.025;key.shadow.bias=-.0003;scene.add(key);const fill=new THREE.DirectionalLight(0xd3e9ef,.7);fill.position.set(8,6,-5);scene.add(fill);}
 lights(tableScene);handScene.add(new THREE.AmbientLight(0xffffff,1.15));
 const handKey=new THREE.DirectionalLight(0xffffff,1.8);handKey.position.set(-300,600,1000);handScene.add(handKey);
 handScene.add(new THREE.HemisphereLight(0xffffff,0x64845d,.6));
 const camera=new THREE.PerspectiveCamera(35,1,.1,100);camera.position.set(0,11,15);camera.lookAt(0,0,0);
 const handCamera=new THREE.OrthographicCamera(0,1,1,0,.1,3000);handCamera.position.set(0,0,1000);handCamera.lookAt(0,0,0);
 const ivory=track(new THREE.MeshPhysicalMaterial({color:0xfffcf1,roughness:.24,metalness:0,clearcoat:.65,clearcoatRoughness:.2})),jade=track(new THREE.MeshPhysicalMaterial({color:0x397629,roughness:.23,metalness:0,clearcoat:.8,clearcoatRoughness:.18}));
 function rounded(w,h,r){const s=new THREE.Shape();s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);s.lineTo(w/2,h/2-r);s.quadraticCurveTo(w/2,h/2,w/2-r,h/2);s.lineTo(-w/2+r,h/2);s.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);s.lineTo(-w/2,-h/2+r);s.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);return s;}
 function block(w,h,d,r=.08){const g=track(new THREE.ExtrudeGeometry(rounded(w,h,r),{depth:d,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:Math.min(r*.38,d*.2),bevelThickness:Math.min(r*.38,d*.2),curveSegments:5}));g.translate(0,0,-d/2);g.computeVertexNormals();return g;}
 const tileGeometry=block(1,1.4,.36,.055),backGeometry=block(1,1.4,.12,.055);
 const faces=await loadTileFaces();
 const backImage=new Image();backImage.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(tileArt(34).replace('<svg ','<svg width="300" height="420" '));await backImage.decode();const backFace=document.createElement('canvas');backFace.width=300;backFace.height=420;backFace.getContext('2d').drawImage(backImage,0,0,300,420);faces.push(backFace);
 const textures=faces.map(c=>{const t=track(new THREE.CanvasTexture(c));t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return track(new THREE.MeshBasicMaterial({map:t,transparent:true,depthWrite:false,toneMapped:false}));});
 const brightFace=track(new THREE.MeshBasicMaterial({color:0xfffbee,toneMapped:false}));
 const faceGeometry=track(new THREE.PlaneGeometry(.89,1.23));
 function tile(type){const g=new THREE.Group(),body=new THREE.Mesh(tileGeometry,[brightFace,ivory]);body.castShadow=true;body.receiveShadow=true;g.add(body);const back=new THREE.Mesh(backGeometry,jade);back.position.z=-.21;g.add(back);const face=new THREE.Mesh(faceGeometry,textures[type]);face.position.z=.223;g.add(face);return g;}
 function slab(w,h,d,y,color,roughness){const m=track(new THREE.MeshStandardMaterial({color,roughness,metalness:color===0xb8a475 ? .55 : 0}));const mesh=new THREE.Mesh(block(w,h,d,.6),m);mesh.rotation.x=-Math.PI/2;mesh.position.y=y;mesh.receiveShadow=true;mesh.castShadow=true;tableScene.add(mesh);return mesh;}
 slab(19.4,9.5,.7,-.6,0x735444,.4);slab(19.05,9.16,.12,-.18,0xb8a475,.42);slab(18.92,9.03,.18,-.11,0x544334,.52);slab(18.15,8.26,.12,.01,0x245d50,.94);
 // Fine woven felt normal variation stays subtle, keeping tile faces dominant.
 const stamp=document.createElement('canvas');stamp.width=256;stamp.height=256;const sc=stamp.getContext('2d');sc.fillStyle='#fff';sc.fillRect(0,0,256,256);for(let y=0;y<256;y+=2){sc.fillStyle=y%4?'#d7d7d7':'#e8e8e8';sc.fillRect(0,y,256,1);}const bump=track(new THREE.CanvasTexture(stamp));bump.wrapS=bump.wrapT=THREE.RepeatWrapping;bump.repeat.set(12,6);const felt=tableScene.children.at(-1);felt.material.map=bump;felt.material.bumpMap=bump;felt.material.bumpScale=.012;
 const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
 const tableTiles=new Map(),handTiles=new Map();
 function syncTable(){if(!model)return;const wanted=new Set();const top=model.table.filter(t=>t.y<42).sort((a,b)=>a.x-b.x);
  for(const t of model.table){const id=`${t.x}:${t.y}:${t.addr}`;wanted.add(id);let g=tableTiles.get(id);if(!g){g=tile(t.tile);g.scale.setScalar(.9);g.userData.arrived=performance.now();tableTiles.set(id,g);tableScene.add(g);}
   let x,y,z,rotX=-Math.PI/2;
   if(t.y<42){x=(top.indexOf(t)-(top.length-1)/2)*.96;y=.68;z=-3.4;rotX=0;}
   else if(t.y>=175){x=-7.7+t.x/512*15.4;y=.28;z=3.0;}
   else if(t.w===33&&t.h===27&&t.x>=340&&t.y>=115){x=3.5+(t.x-342)/31*.97;y=.28+(t.y<128?.23:0);z=-.3+(t.y<128?0:.65);}
   else{x=-3.4+(t.x-170)/170*6.6;y=.24;z=-2.35+(t.y-42)/140*4.5;}
   g.userData.target={x,y,z};g.rotation.x=rotX;if(!g.userData.positioned){g.position.set(x,y+(reducedMotion.matches?0:.4),z);g.userData.positioned=true;}
  }for(const [id,g] of tableTiles)if(!wanted.has(id)){tableScene.remove(g);tableTiles.delete(id);}
 }
 function syncHand(){if(!model)return;const wanted=new Set();for(const button of rack.querySelectorAll('button[data-slot]')){const slot=Number(button.dataset.slot),t=model.hand.find(t=>t.slot===slot);if(!t)continue;const id=`${slot}:${t.tile}`;wanted.add(id);let g=handTiles.get(id);if(!g){g=tile(t.tile);handScene.add(g);handTiles.set(id,g);}g.userData.button=button;g.userData.slot=slot;}
  for(const [id,g] of handTiles)if(!wanted.has(id)){handScene.remove(g);handTiles.delete(id);}
 }
 function resize(){const w=arena.clientWidth,h=arena.clientHeight;if(w&&h){tableRenderer.setSize(w,h,false);camera.aspect=w/h;camera.position.set(0,11,15);camera.zoom=Math.min(1.24,Math.max(.65,camera.aspect/2.05));camera.updateProjectionMatrix();}
  const host=root.querySelector('.hand-area'),hw=host.clientWidth,hh=host.clientHeight;handRenderer.setSize(hw,Math.max(1,hh),false);handCamera.left=0;handCamera.right=hw;handCamera.top=hh;handCamera.bottom=0;handCamera.updateProjectionMatrix();}
 const observer=new ResizeObserver(resize);observer.observe(arena);observer.observe(root.querySelector('.hand-area'));resize();
 function render(now){if(disposed)return;frame=requestAnimationFrame(render);if(document.hidden||now-previous<32)return;previous=now;
  for(const g of tableTiles.values()){const p=g.userData.target;g.position.lerp(new THREE.Vector3(p.x,p.y,p.z),reducedMotion.matches?1:.3);}
  const host=root.querySelector('.hand-area'),rect=host.getBoundingClientRect();
  for(const g of handTiles.values()){const b=g.userData.button;if(!b.isConnected)continue;const r=b.getBoundingClientRect();const selected=g.userData.slot===selectedSlot;const w=r.width*.94,h=r.height*.96;g.scale.set(w,h/1.4,Math.min(w,h)*.7);g.position.x=r.x-rect.x+r.width/2;g.position.y=rect.height-(r.y-rect.y+r.height/2)+(selected?7:0);g.position.z=selected?18:5;g.rotation.x=.3;g.rotation.y=-.055;}
  tableRenderer.render(tableScene,camera);handRenderer.render(handScene,handCamera);
 }
 frame=requestAnimationFrame(render);root.classList.add('real-3d');
 return{update(next,slot){model=next;selectedSlot=slot;syncTable();syncHand();},select(slot){selectedSlot=slot;},close(){disposed=true;cancelAnimationFrame(frame);observer.disconnect();for(const r of renderers){r.dispose();r.forceContextLoss();}for(const r of resources)r.dispose();tableCanvas.remove();handCanvas.remove();root.classList.remove('real-3d');}};
}
