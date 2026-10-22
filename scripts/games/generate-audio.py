"""ATT-inspired resynthesis from measured pitches and timing, with fuller body.
No video recordings are distributed. Source/measurements: docs/games/AUDIO_REFINEMENT.md.
Standard-library-only deterministic PCM generator; run from repository root.
"""
import math,wave,struct,json,hashlib,pathlib
SR=44100
OUT=pathlib.Path('apps/desktop/public/audio/poker');OUT.mkdir(parents=True,exist_ok=True)
def canvas(seconds):return [0.0]*round(seconds*SR)
def tone(buf,start,freq,duration=.185,amp=1):
    offset=round(start*SR)
    for i in range(round(duration*SR)):
        t=i/SR;p=2*math.pi*freq*t
        env=min(1,t/.0025)*math.exp(-max(0,t-.007)/.049)*min(1,(duration-t)/.009)
        v=(math.sin(p)+.19*math.sin(2*p)+.34*math.sin(3*p)+.15*math.sin(5*p)+.11*math.sin(7*p))*.39*env
        v+=.055*math.sin(p)*min(1,t/.006)*math.exp(-t/.09)*min(1,(duration-t)/.015)
        if offset+i<len(buf):buf[offset+i]+=v*amp

def melody(notes,step=.08,tail=.2):
    b=canvas((len(notes)-1)*step+tail)
    for i,f in enumerate(notes):tone(b,i*step,f,min(.185,step*1.6))
    return b
scale=[130.81,146.83,164.81,174.61,196.0]
sounds={}
for i,f in enumerate(scale):
    b=canvas(.185);tone(b,0,f);sounds['deal'+str(i+1)]=b
sounds['deal']=sounds['deal1'];sounds['flip']=sounds['deal5']
b=canvas(.185);tone(b,0,116.54,.175,.78);sounds['shuffle']=b
b=canvas(.15);tone(b,0,261.63,.14,.7);sounds['hold']=b
b=canvas(.15);tone(b,0,196,.14,.65);sounds['release']=b
# Reference short win figure; the same timbre carries every cue.
win=[130.81,164.81,196,146.83,174.61,220,164.81,196,261.63]
sounds['double']=melody(win)
# Brighter major-key award flourish; dealing and double-up cues stay classic.
def fanfare(seconds,step):
    b=canvas(seconds)
    notes=[261.63,329.63,392,329.63,392,523.25,392,523.25,659.25]
    for i,f in enumerate(notes):
        tone(b,i*step,f,.185,.85)
        tone(b,i*step,f/2,.185,.30)
    ending=(len(notes)-1)*step+.12
    for j,f in enumerate([261.63,329.63,392,523.25]):tone(b,ending+j*.022,f,.28,.34)
    tone(b,0,130.81,.2,.40);tone(b,step*4,196,.2,.35)
    return b
sounds['pair']=fanfare(1.2,.085)
sounds['win']=melody(win)
sounds['bigwin']=melody(win,.095,.24)
sounds['jackpot']=melody(win,.11,.3)
sounds['intro']=melody(scale,.12,.22)
sounds['even']=melody([196,261.63],.095,.185)
sounds['loss']=melody([196,164.81,130.81],.095,.185)
sounds['push']=melody([196,196],.15,.185)
# Descending double-up entry sweep; no looping suspense music.
b=canvas(.45);phase=0
for i in range(len(b)):
    t=i/SR;f=784*2**(-min(t/.22,1));phase+=2*math.pi*f/SR
    env=min(1,t/.003)*math.exp(-max(0,t-.12)/.10)*min(1,(.45-t)/.018)
    b[i]=.21*env*(math.sin(phase)+.24*math.sin(phase*3)+.08*math.sin(phase*2))
sounds['roll']=b
# Reference's rapid alternating score register, with a quieter low-mid body.
# 132ms loop contains four 33ms cycles; last cycle joins without a click.
b=canvas(.132);phase=0;lowphase=0
for i in range(len(b)):
    t=i/SR;f=1416 if (t% .033)<.0165 else 585
    phase+=2*math.pi*f/SR;lowphase+=2*math.pi*385/SR
    edge=min(1,(t% .0165)/.001,min(.0165-t% .0165,.001)/.001)
    b[i]=(.15*(math.sin(phase)+.17*math.sin(3*phase))+.055*math.sin(lowphase))*max(0,edge)
sounds['collect']=b
manifest={'source':'Original additive resynthesis; ATT reference pitch/rhythm measurements, enhanced low-mid body; no third-party recordings','reference':'https://www.bilibili.com/video/BV1DH4y1k7XE/','sampleRate':SR,'version':'att-award-2','cardIntervalMs':195,'cardFrequenciesHz':scale,'files':{}}
encoded={}
for name,b in sounds.items():
    for i in range(min(80,len(b))):b[-1-i]*=i/80
    b=[.85*math.tanh(v/.85) for v in b];encoded[name]=b
    raw=struct.pack('<'+'h'*len(b),*[int(v*32767) for v in b]);target=OUT/(name+'.wav')
    with wave.open(str(target),'wb') as f:f.setparams((1,2,SR,0,'NONE','not compressed'));f.writeframes(raw)
    peak=max(abs(v) for v in b);rms=math.sqrt(sum(v*v for v in b)/len(b))
    manifest['files'][name]={'seconds':round(len(b)/SR,4),'peakDbFS':round(20*math.log10(peak),2),'rmsDbFS':round(20*math.log10(rms),2),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(sounds),'bytes':sum(x['bytes'] for x in manifest['files'].values()),'maxPeakDbFS':max(x['peakDbFS'] for x in manifest['files'].values())}))
