"""Local development only: pinned pywhispercpp runtime, no downloads or user logs."""
import json
import sys
import wave
import numpy as np
from pywhispercpp.model import Model

with wave.open(sys.argv[2]) as stream:
    if stream.getframerate() != 16000 or stream.getnchannels() != 1 or stream.getsampwidth() != 2:
        raise ValueError('AUDIO_INVALID')
    audio = np.frombuffer(stream.readframes(stream.getnframes()), dtype=np.int16).astype(np.float32) / 32768
model = Model(sys.argv[1], context_params={'use_gpu': False}, n_threads=4,
              print_progress=False, print_realtime=False, language='en', no_context=True,
              redirect_whispercpp_logs_to=None)
segments = model.transcribe(audio)
print(json.dumps({'transcript': ' '.join(segment.text for segment in segments).strip()}))
