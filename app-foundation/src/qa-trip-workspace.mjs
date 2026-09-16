// Never opens the user's database. The entire QA database lives in memory.
import {workspaceFixture} from '../test/trip-workspace-fixture.mjs';
import {createWorkspaceServer} from './web-server.mjs';
const db=await workspaceFixture(),app=createWorkspaceServer({db});
const info=await app.listen();console.log(JSON.stringify({pid:process.pid,origin:info.origin,setupUrl:info.setupUrl,synthetic:true,persistent:false}));
async function stop(){await app.close();await db.close();process.exit(0);}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
