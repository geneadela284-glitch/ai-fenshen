// Enhances a supplied original signal. No generated melody, resampling, pitch shift or delay.
// Await original-game integration before connecting this graph to the product audio output.
export function createMahjongAudioEnhancement(context,{enabled=true,volume=.8}={}){
  const input=context.createGain(),dry=context.createGain(),wet=context.createGain(),body=context.createBiquadFilter(),output=context.createGain();
  body.type='lowshelf';body.frequency.value=180;body.gain.value=2;
  // Reserve headroom for the shelf boost; retain the original attack and transient envelope.
  wet.gain.value=enabled?.78:0;dry.gain.value=enabled?0:1;
  output.gain.value=Math.max(0,Math.min(1,volume));
  input.connect(dry);dry.connect(output);input.connect(body);body.connect(wet);wet.connect(output);
  let closed=false;
  const ramp=(param,value)=>{param.cancelScheduledValues(context.currentTime);param.setValueAtTime(param.value,context.currentTime);param.linearRampToValueAtTime(value,context.currentTime+.015);};
  return {input,output,setEnabled(value){if(closed)return;ramp(wet.gain,value?.78:0);ramp(dry.gain,value?0:1);},setVolume(value){if(closed||!Number.isFinite(value))return;ramp(output.gain,Math.max(0,Math.min(1,value)));},close(){if(closed)return;closed=true;for(const node of [input,dry,wet,body,output])node.disconnect();}};
}
