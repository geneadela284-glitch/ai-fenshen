// Authored raster glyphs; slicing never reads native game state.
// The generated seven-bamboo cell has only five stems, so it is deliberately
// NOT used. Build the correct seven from the verified one-stem raster samples.
const xs=[1,177,352,530,711,887,1070,1250,1448,1628],ys=[1,245,478,725,964];
async function buildTileFaces(){
 const image=new Image();image.src='/host/tile-faces-v3.png';await image.decode();
 const faces=Array.from({length:34},(_,type)=>{
  const canvas=document.createElement('canvas');canvas.width=300;canvas.height=420;const ctx=canvas.getContext('2d');
  const row=Math.floor(type/9),col=type%9;
  ctx.drawImage(image,xs[col]+7,ys[row]+7,xs[col+1]-xs[col]-14,ys[row+1]-ys[row]-14,0,0,300,420);
  return canvas;
 });
 // Sample complete glyphs by their ink, rather than approximate crop coordinates.
 function sample(source,color,right=source.width){const im=source.getContext('2d').getImageData(0,0,source.width,source.height);let x0=right,y0=source.height,x1=0,y1=0;for(let y=0;y<source.height;y++)for(let x=0;x<right;x++){const i=(y*source.width+x)*4,[r,g,b]=im.data.slice(i,i+3);if(color==='green'?g>r*1.3&&g>b*1.3&&g<190:color==='blue'?b>r*1.3&&b>g*1.15&&r<160:r>g*1.5&&r>b*1.5&&g<160){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}}const c=document.createElement('canvas');c.width=x1-x0+5;c.height=y1-y0+5;const ctx=c.getContext('2d');ctx.drawImage(source,x0-2,y0-2,c.width,c.height,0,0,c.width,c.height);const pixels=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<pixels.data.length;i+=4){const [r,g,b]=pixels.data.slice(i,i+3);if(!(color==='green'?g>r*1.2&&g>b*1.2:color==='blue'?b>r*1.2&&b>g*1.1:r>g*1.3&&r>b*1.3))pixels.data[i+3]=0;}ctx.putImageData(pixels,0,0);return c;}
 const greenStem=sample(faces[19],'green',150),redStem=sample(faces[22],'red');
 const pips=new Image();pips.src='/host/circle-pips-v4.png';await pips.decode();
 const pipCell=(col,row)=>{const c=document.createElement('canvas');c.width=pips.width/2;c.height=pips.height/2;c.getContext('2d').drawImage(pips,col*pips.width/2,row*pips.height/2,pips.width/2,pips.height/2,0,0,c.width,c.height);return c;};
 const greenCircle=sample(pipCell(0,1),'green'),redCircle=sample(pipCell(1,1),'red'),blueCircle=sample(faces[10],'blue');
 // Preserve the user's accepted two-circle tile unchanged.
 const rosette=faces[9].getContext('2d');rosette.clearRect(0,0,300,420);rosette.drawImage(pips,75,75,470,470,20,80,260,260);
 // Conventional Chinese bamboo arrangements, checked against the supplied game.
 const layouts={
  19:[[129,34,'g'],[129,254,'g']],
  20:[[129,34,'g'],[60,254,'g'],[198,254,'g']],
  21:[[60,34,'g'],[198,34,'g'],[60,254,'g'],[198,254,'g']],
  22:[[60,24,'g'],[198,24,'g'],[129,154,'r'],[60,284,'g'],[198,284,'g']],
  23:[[52,34,'g'],[129,34,'g'],[206,34,'g'],[52,254,'g'],[129,254,'g'],[206,254,'g']],
  24:[[129,20,'r'],[52,151,'g'],[129,151,'g'],[206,151,'g'],[52,282,'g'],[129,282,'g'],[206,282,'g']],
  25:[[44,20,'g'],[210,20,'g'],[44,151,'g'],[210,151,'g'],[44,282,'g'],[210,282,'g'],[129,85,'r'],[129,216,'r']],
  26:[[52,20,'g'],[129,20,'r'],[206,20,'g'],[52,151,'g'],[129,151,'r'],[206,151,'g'],[52,282,'g'],[129,282,'r'],[206,282,'g']]
 };
 for(const [id,marks] of Object.entries(layouts)){const ctx=faces[id].getContext('2d');ctx.clearRect(0,0,300,420);for(const [x,y,color] of marks)ctx.drawImage(color==='r'?redStem:greenStem,x,y,43,107);}
 const eightImage=new Image();eightImage.src='/host/eight-bamboo-v3.png';await eightImage.decode();const eight=faces[25].getContext('2d');eight.clearRect(0,0,300,420);eight.drawImage(eightImage,0,0,300,420);
 // Traditional circle layouts from the supplied Guangdong reference.
 const dotLayouts={
  11:{size:108,marks:[[18,28,'g'],[96,155,'r'],[174,282,'b']]},
  12:{size:112,marks:[[24,69,'b'],[164,69,'g'],[24,239,'g'],[164,239,'b']]},
  13:{size:99,marks:[[18,25,'b'],[183,25,'g'],[101,160,'r'],[18,295,'g'],[183,295,'b']]},
  14:{size:110,marks:[[30,23,'g'],[160,23,'g'],[30,157,'r'],[160,157,'r'],[30,291,'r'],[160,291,'r']]},
  15:{size:104,marks:[[11,12,'g'],[98,56,'g'],[185,100,'g'],[30,213,'r'],[166,213,'r'],[30,316,'r'],[166,316,'r']]},
  16:{size:96,marks:[[41,10,'b'],[163,10,'b'],[41,111,'b'],[163,111,'b'],[41,212,'b'],[163,212,'b'],[41,313,'b'],[163,313,'b']]},
  17:{size:90,marks:[[9,48,'b'],[105,48,'b'],[201,48,'b'],[9,165,'r'],[105,165,'r'],[201,165,'r'],[9,282,'g'],[105,282,'g'],[201,282,'g']]}
 };
 for(const [id,{size,marks}] of Object.entries(dotLayouts)){const ctx=faces[id].getContext('2d');ctx.clearRect(0,0,300,420);for(const[x,y,color]of marks)ctx.drawImage(color==='r'?redCircle:color==='g'?greenCircle:blueCircle,x,y,size,size);}
 const details=new Image();details.src='/host/bird-white-v3.png';await details.decode();for(const [id,column]of [[18,0],[31,1]]){const ctx=faces[id].getContext('2d');ctx.clearRect(0,0,300,420);ctx.drawImage(details,column*details.width/2,0,details.width/2,details.height,0,0,300,420);}
 // Remove the white paper ground, preserving the original painted raster edges.
 for(const canvas of faces){const ctx=canvas.getContext('2d'),im=ctx.getImageData(0,0,canvas.width,canvas.height);for(let i=0;i<im.data.length;i+=4){if(!im.data[i+3])continue;const r=im.data[i],g=im.data[i+1],b=im.data[i+2],low=Math.min(r,g,b),high=Math.max(r,g,b);if(low>222||(high-low<20&&low>140))im.data[i+3]=0;else if(low>185)im.data[i+3]=Math.round((222-low)/37*255);}ctx.putImageData(im,0,0);}
 return faces;
}

let cached;
export function loadTileFaces(){return cached??=(buildTileFaces());}
