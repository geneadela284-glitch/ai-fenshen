// The original emulator canvas remains the sole picture source.
// Two edge-aware 2x passes retain the source palette and layout.
// Algorithm: https://www.scale2x.it/algorithm
export class OriginalHDView {
  constructor(source, screen) {
    this.source = source;
    // SDL3 expands its backing canvas on Retina displays. Recover the original
    // 256x232 palette pixels before repair and input-state observation.
    this.nativeSource = document.createElement('canvas');
    this.nativeSource.width = 256;
    this.nativeSource.height = 232;
    this.nativeContext = this.nativeSource.getContext('2d', { willReadFrequently: true });
    this.nativeContext.imageSmoothingEnabled = false;
    this.picture = document.createElement('canvas');
    this.pictureContext = this.picture.getContext('2d', {willReadFrequently:true});
    this.layout = 'landscape';
    this.screen = screen;
    this.frames = 0;
    this.mode = 'hd';
    this.gl = screen.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!this.gl) throw new Error('当前环境无法开启高清显示');
    const gl = this.gl;
    const vertex = this.compile(gl.VERTEX_SHADER, `
      attribute vec2 aPosition;
      varying vec2 vUV;
      void main(){vUV=(aPosition+1.0)*0.5;gl_Position=vec4(aPosition,0.0,1.0);}
    `);
    const fragment = this.compile(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform sampler2D uImage;
      uniform vec2 uSize;
      uniform bool uRepair;
      uniform bool uHideHolds;
      varying vec2 vUV;
      vec4 pixel(vec2 p){
        p=clamp(p,vec2(0.0),uSize-1.0);
        float row=uSize.y-1.0-p.y;
        if(uHideHolds&&row>=168.0&&row<176.0&&p.x>=16.0){return texture2D(uImage,vec2(8.5,uSize.y-8.5)/uSize);}
        return texture2D(uImage,(p+0.5)/uSize);
      }
      bool same(vec4 a,vec4 b){return all(lessThan(abs(a-b),vec4(0.001)));}
      void main(){
        vec2 p=floor(vUV*uSize);
        vec4 e=pixel(p);
        if(!uRepair){gl_FragColor=e;return;}
        vec4 left=pixel(p+vec2(-1.0,0.0));
        vec4 right=pixel(p+vec2(1.0,0.0));
        vec4 upper=pixel(p+vec2(0.0,1.0));
        vec4 lower=pixel(p+vec2(0.0,-1.0));
        vec2 sub=fract(vUV*uSize);
        if(!same(upper,lower)&&!same(left,right)){
          vec4 side=sub.x<0.5?left:right;
          vec4 vertical=sub.y<0.5?lower:upper;
          if(same(side,vertical))e=side;
        }
        gl_FragColor=e;
      }
    `);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    gl.useProgram(this.program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.sizeUniform = gl.getUniformLocation(this.program, 'uSize');
    this.repairUniform = gl.getUniformLocation(this.program, 'uRepair');
    this.hideHoldsUniform = gl.getUniformLocation(this.program, 'uHideHolds');
    gl.uniform1i(gl.getUniformLocation(this.program, 'uImage'), 0);
    this.input = this.texture();
    this.intermediate = this.texture();
    this.framebuffer = gl.createFramebuffer();
    screen.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.stopped = true;
      screen.dispatchEvent(new CustomEvent('hd-error', { detail: '高清显示暂时中断，请保留页面' }));
    });
  }

  compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  texture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  draw() {
    if (this.stopped || !this.source.width || !this.source.height) return;
    const gl = this.gl;
    this.nativeContext.drawImage(this.source, 0, 0, 256, 232);
    // Only presentation is rearranged. Native pixels remain untouched for
    // the machine, held-state detection, and diagnostics.
    const portrait = this.layout === 'portrait';
    const width = 256, height = portrait ? 458 : 204;
    if(this.picture.width!==width||this.picture.height!==height){this.picture.width=width;this.picture.height=height;}
    const ctx=this.pictureContext;ctx.imageSmoothingEnabled=false;
    const color=this.nativeContext.getImageData(8,8,1,1).data;
    ctx.fillStyle=`rgb(${color[0]},${color[1]},${color[2]})`;ctx.fillRect(0,0,width,height);
    ctx.drawImage(this.nativeSource,0,0,256,80,0,0,256,80);
    this.cardRects=Array.from({length:5},(_,i)=>{
      const scale=portrait?16/9:1,slot=256/3;
      const x=portrait?(i<3?i*slot:(i-3+.5)*slot)+(slot-40*scale)/2:16+i*48;
      const y=portrait?(i<3?88:258):82;
      const rect={x,y,width:40*scale,height:88*scale};
      ctx.drawImage(this.nativeSource,16+i*48,80,40,88,x,y,rect.width,rect.height);
      return rect;
    });
    // Fit every non-background footer pixel inside a fixed prompt band.
    // Flashing messages may move inside this band; card geometry never does.
    const pixels=this.nativeContext.getImageData(0,176,256,56).data;
    let first=56,last=-1;
    for(let row=0;row<56;row++)for(let x=0;x<256;x++){
      const p=(row*256+x)*4;
      if(pixels[p]!==color[0]||pixels[p+1]!==color[1]||pixels[p+2]!==color[2]){first=Math.min(first,row);last=Math.max(last,row);break;}
    }
    if(last>=first){const h=last-first+1,band=portrait?42:30,k=Math.min(1,band/h);ctx.drawImage(this.nativeSource,0,176+first,256,h,(256-256*k)/2,height-band+(band-h*k)/2,256*k,h*k);}
    if (this.sourceWidth !== width || this.sourceHeight !== height) {
      this.sourceWidth = width;
      this.sourceHeight = height;
      this.screen.width = width * 4;
      this.screen.height = height * 4;
      gl.bindTexture(gl.TEXTURE_2D, this.intermediate);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width * 2, height * 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.intermediate, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('高清显示缓冲不可用');
    }
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.input);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.picture);
    gl.uniform1i(this.repairUniform, this.mode === 'hd' ? 1 : 0);
    gl.uniform1i(this.hideHoldsUniform, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, width * 2, height * 2);
    gl.uniform2f(this.sizeUniform, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.intermediate);
    gl.uniform1i(this.hideHoldsUniform, 0);
    gl.viewport(0, 0, this.screen.width, this.screen.height);
    gl.uniform2f(this.sizeUniform, width * 2, height * 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.frames++;
  }

  getStats() {
    return { mode: this.mode, frames: this.frames, width: this.screen.width, height: this.screen.height, sourceWidth: this.nativeSource.width, sourceHeight: this.nativeSource.height, layout:this.layout,cardRects:this.cardRects,hostWidth: this.source.width, hostHeight: this.source.height, glError: this.gl.getError() };
  }
}
