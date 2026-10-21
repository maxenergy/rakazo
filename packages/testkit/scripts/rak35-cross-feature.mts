import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createDb } from '../../db/src/client.ts';
import { setProjectBudget, reserveBudget } from '../../db/src/project-budgets.ts';
import { recordUsage } from '../../db/src/usage.ts';
import { addTicketDependency, readTicketDependencies } from '../../db/src/ticket-dependencies.ts';
import { REPO_ROOT, startDisposableCluster } from '../src/acceptance/disposable-postgres.ts';
import { trackPool, endPool } from '../src/acceptance/pool-lifecycle.ts';
const root=REPO_ROOT;
import { claimEmptySpaceDeletionForMember, deleteEmptySpaceForMember } from '../../db/src/spaces.ts';
console.log(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim());
const upgradeRoot=process.env.RAK_UPGRADE_BASELINE_ROOT;
if (!upgradeRoot) throw new Error('RAK_UPGRADE_BASELINE_ROOT must point to the approved baseline checkout');
const cluster=await startDisposableCluster();
async function diagnostic(url:string,label:string,transition?:()=>Promise<void>){
 let {prisma:p,pool}=createDb(url); trackPool(pool);
 const s='diag-'+label, project=s+'-project', callId=s+'-call';
 try {
 await p.organization.create({data:{id:s,name:'Synthetic diagnostic',slug:s,createdAt:new Date()}});
 await p.space.create({data:{id:s,organizationId:s,name:'Synthetic'}});
 await p.project.create({data:{id:project,spaceId:s,name:'Synthetic'}});
 const board=await p.board.create({data:{spaceId:s,name:'Synthetic',ticketPrefix:'SYN'}});
 const a=await p.ticket.create({data:{spaceId:s,boardId:board.id,projectId:project,number:1,title:'A'}});
 const b=await p.ticket.create({data:{spaceId:s,boardId:board.id,projectId:project,number:2,title:'B'}});
 await p.$transaction(tx=>addTicketDependency(tx,s,b.id,a.id));
 assert.equal((await p.$transaction(tx=>readTicketDependencies(tx,s,b.id))).blockedByDependency,true);
 const goal=await p.goal.create({data:{spaceId:s,projectId:project,name:'Synthetic'}});
 const kr=await p.keyResult.create({data:{spaceId:s,projectId:project,goalId:goal.id,name:'Synthetic',measure:'count',calculationRule:'Explicit updates',currentValue:0,targetValue:1}});
 if (label === 'upgrade') {
   await p.$executeRaw`INSERT INTO project_budgets (id, "spaceId", "projectId", version, "limitMicroUsd", "reservedMicroUsd", "settledMicroUsd", "updatedAt") VALUES (${s+'-budget'}, ${s}, ${project}, 1, 1000000, 0, 125000, CURRENT_TIMESTAMP)`;
   await p.$executeRaw`INSERT INTO project_budget_versions ("budgetId", version, "limitMicroUsd") VALUES (${s+'-budget'}, 1, 1000000)`;
   await p.$executeRaw`INSERT INTO budget_reservations (id, "budgetId", "spaceId", "projectId", "budgetVersion", "callId", "amountMicroUsd", "settledMicroUsd", status, "expiresAt", "closedAt") VALUES (${s+'-reservation'}, ${s+'-budget'}, ${s}, ${project}, 1, ${callId}, 500000, 125000, 'settled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
   await p.$executeRaw`INSERT INTO usage_records (id, "spaceId", "userId", provider, model, "inputTokens", "outputTokens", "costUsd", "callId") VALUES (${s+'-usage'}, ${s}, 'synthetic-user', 'synthetic', 'fake', 10, 2, 0.125, ${callId})`;
 } else {
 await setProjectBudget(p,{spaceId:s,projectId:project,limitMicroUsd:1000000n});
 await reserveBudget(p,{spaceId:s,projectId:project,callId,amountMicroUsd:500000n});
 const fakeAdapter=async()=>({type:'usage' as const,provider:'synthetic',model:'fake',callId,inputTokens:10,outputTokens:2,costUsd:0.125,costUsdDecimal:'0.125',billingKind:'metered' as const});
 const event=await fakeAdapter();
 const attribution={spaceId:s,userId:'synthetic-user',projectId:project};
 await recordUsage(p,event,attribution);
 await recordUsage(p,event,attribution);
 assert.equal(await p.usageRecord.count({where:{callId}}),1);
 const budget=await p.projectBudget.findFirstOrThrow({where:{spaceId:s,projectId:project}});
 assert.equal(budget.reservedMicroUsd,0n); assert.equal(budget.settledMicroUsd,125000n);
 const reservation=await p.budgetReservation.findFirstOrThrow({where:{spaceId:s,callId}});
 assert.equal(reservation.status,'settled');
 }
 await p.ticket.update({where:{id:a.id},data:{status:'done'}});
 assert.equal((await p.$transaction(tx=>readTicketDependencies(tx,s,b.id))).blockedByDependency,false);
 assert.equal((await p.keyResult.findUniqueOrThrow({where:{id:kr.id}})).currentValue,0);
 await p.keyResult.update({where:{id:kr.id},data:{currentValue:1}});
 assert.equal((await p.keyResult.findUniqueOrThrow({where:{id:kr.id}})).currentValue,1);
 // Capture exact persisted feature rows before migration/restart, then compare
 // through a new client. No fixture writes occur between capture and comparison.
 const snapshot = async (db: typeof p) => ({
   tickets: await db.ticket.findMany({where:{spaceId:s},orderBy:{id:'asc'}}),
   dependencies: await db.$transaction(tx=>readTicketDependencies(tx,s,b.id)),
   goal: await db.goal.findUniqueOrThrow({where:{id:goal.id}}),
   kr: await db.keyResult.findUniqueOrThrow({where:{id:kr.id}}),
   budget: await db.projectBudget.findMany({where:{spaceId:s},orderBy:{id:'asc'}}),
   reservations: await db.budgetReservation.findMany({where:{spaceId:s},orderBy:{id:'asc'},select:{id:true,budgetId:true,spaceId:true,projectId:true,budgetVersion:true,callId:true,amountMicroUsd:true,settledMicroUsd:true,overrunMicroUsd:true,status:true,settledLate:true,expiresAt:true,createdAt:true,closedAt:true}}),
   usage: await db.usageRecord.findMany({where:{callId},orderBy:{id:'asc'},select:{id:true,spaceId:true,userId:true,provider:true,model:true,inputTokens:true,outputTokens:true,costUsd:true,callId:true,createdAt:true}}),
 });
 const before = await snapshot(p);
 if (transition) {
   await p.$disconnect(); await endPool(pool);
   await transition();
   const reopened=createDb(url); trackPool(reopened.pool);
   p=reopened.prisma; pool=reopened.pool;
   assert.deepEqual(await snapshot(p),before, label+' retained feature rows');
   console.log(JSON.stringify({label,retainedRowsEqual:true}));
 }
 const userId=s+'-owner';
 await p.user.create({data:{id:userId,name:'Synthetic owner',email:userId+'@example.invalid'}});
 await p.member.create({data:{id:s+'-member',organizationId:s,userId,role:'owner',createdAt:new Date()}});
 const fallback=s+'-fallback';
 await p.space.create({data:{id:fallback,organizationId:s,name:'Synthetic fallback',isDefault:true}});
 for (const spaceId of [s,fallback]) await p.spaceMember.create({data:{id:spaceId+'-membership',spaceId,organizationId:s,userId,role:'owner',createdAt:new Date()}});
 const deletion={currentSpaceId:fallback,userId,spaceId:s};
 const claim=await claimEmptySpaceDeletionForMember(p,deletion);
 await deleteEmptySpaceForMember(p,{...deletion,claimId:claim.claimId});
 const tables=await p.$queryRawUnsafe<Array<{table_name:string}>>("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='spaceId'");
 for(const {table_name} of tables){
 const rows=await p.$queryRawUnsafe<Array<{n:bigint}>>('SELECT count(*) AS n FROM "'+table_name.replaceAll('"','""')+'" WHERE "spaceId"=$1',s);
 assert.equal(rows[0]!.n,0n,'orphan rows in '+table_name);
 }
 await p.organization.delete({where:{id:s}});
 await p.user.delete({where:{id:userId}});
 console.log(JSON.stringify({label,ok:true,usageRows:1,settledMicroUsd:'125000',orphanRows:0}));
 } finally {await p.$disconnect();await endPool(pool);}
}
try {
 const fresh=await cluster.createDatabase('diagnostic_fresh');
 console.log('disposablePort='+new URL(cluster.url(fresh)).port);
 await cluster.migrate(fresh);
 await diagnostic(cluster.url(fresh),'fresh');
 const upgrade=await cluster.createDatabase('diagnostic_upgrade');
 execFileSync('pnpm',['exec','prisma','migrate','deploy'],{cwd:path.join(upgradeRoot,'packages/db'),env:{...process.env,DATABASE_URL:cluster.url(upgrade)},stdio:'pipe'});
 await diagnostic(cluster.url(upgrade),'upgrade',()=>cluster.migrate(upgrade));
 await diagnostic(cluster.url(upgrade),'restart',()=>cluster.restartServer());
 console.log(JSON.stringify({ok:true,scenarios:3}));
} finally {await cluster.stop();}
