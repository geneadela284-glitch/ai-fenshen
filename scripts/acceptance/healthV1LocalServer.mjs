import {createHealthHarness} from '../../server/health/testHarness.js';
const h=await createHealthHarness({port:Number(process.env.HEALTH_PREVIEW_PORT||55882),publicDir:new URL('../../apps/desktop/dist',import.meta.url).pathname,directory:process.env.HEALTH_PREVIEW_DATA||'/private/tmp/health-v1-preview-data'});
console.log(JSON.stringify({url:h.baseUrl,username:h.username,password:h.password,mode:'synthetic-preview-no-real-AI'}));
