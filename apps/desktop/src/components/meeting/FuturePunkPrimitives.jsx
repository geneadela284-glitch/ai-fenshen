import React from 'react';

export function MeetingBrand({ className = '' } = {}) {
  return (
    <div className={`meeting-v1-brand ${className}`.trim()} aria-label="AI分身 Meeting">
      <span className="meeting-v1-brand__orb" aria-hidden="true"><span /></span>
      <span className="meeting-v1-brand__copy">
        <strong>AI分身</strong>
        <small>MEETING MIND</small>
      </span>
    </div>
  );
}

export function FuturePunkOrb({ size = 'large', state = 'idle', className = '' } = {}) {
  return (
    <div className={`meeting-v1-orbital meeting-v1-orbital--${size} meeting-v1-orbital--${state} ${className}`.trim()} aria-hidden="true">
      <span className="meeting-v1-orbital__ring meeting-v1-orbital__ring--one" />
      <span className="meeting-v1-orbital__ring meeting-v1-orbital__ring--two" />
      <span className="meeting-v1-orbital__ring meeting-v1-orbital__ring--three" />
      <span className="meeting-v1-orbital__satellite meeting-v1-orbital__satellite--one" />
      <span className="meeting-v1-orbital__satellite meeting-v1-orbital__satellite--two" />
      <span className="meeting-v1-brain-orb"><span className="meeting-v1-brain-orb__glyph"><i /><i /></span></span>
    </div>
  );
}

export default MeetingBrand;
