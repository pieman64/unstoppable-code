import { createRequire } from 'node:module';
import {
  getDatadogInstrumentationReadiness,
  getDesktopInstrumentationConfig,
} from '../config';

const datadogConfig = getDesktopInstrumentationConfig().datadog;
if (getDatadogInstrumentationReadiness(datadogConfig).enabled) {
  createRequire(import.meta.url)('@datadog/electron-sdk/preload');
}
