import {
  IOS_AAC_CAPTURE_UNIT_MS,
  ROTATING_INDEPENDENT_MP4_MODE
} from './meetingRecordingContainerLayout.js';

export const ACTIVE_REQUEST_DATA_MODE = 'active-request-data';
export const PASSIVE_NATIVE_TIMESLICE_MODE = 'passive-native-timeslice';
export const IOS_AAC_NATIVE_TIMESLICE_MS = 12_000;

export function isPassiveNativeTimesliceMode(value) {
  return value === PASSIVE_NATIVE_TIMESLICE_MODE;
}

export function isRotatingIndependentMp4Mode(value) {
  return value === ROTATING_INDEPENDENT_MP4_MODE;
}

export { IOS_AAC_CAPTURE_UNIT_MS, ROTATING_INDEPENDENT_MP4_MODE };
