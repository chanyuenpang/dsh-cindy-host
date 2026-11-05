// Pinned Cindy maker-shared/syntheticTrigger constants; actual-consumer tests
// assert byte equality. These are explicit manual inputs, never tool retries.
const COMMON = ' Review the conversation above to determine how far the task progressed,'
  + ' then continue from where it left off.'
  + ' Do not repeat steps that already completed and had external effects'
  + ' (messages or comments already sent, commits already pushed, files already written).';
export const CONTINUE_INTERRUPTED = '[UI_ACTION_TRIGGER] The previous turn was interrupted because the app exited mid-run.' + COMMON;
export const CONTINUE_ERROR = '[UI_ACTION_TRIGGER] The previous turn errored partway through.' + COMMON;
export function continuationKind(text) { return text === CONTINUE_INTERRUPTED ? 'interrupted' : text === CONTINUE_ERROR ? 'error' : null; }

/** Public native getters/projections prove the effective switch; never parse command prose. */
export async function ensureNativeContinuationPlanOff({agent,controller,getService}) {
  try {
    const registry=agent?.ctx?.get?.('sessionProjections')??getService('sessionProjections');
    const read=()=>controller?.get?.(agent)??registry?.stateOf?.(agent.session,'plan');
    const off=()=>{const state=read();return state?.active===false&&state.pending!==true&&state.wanted!==true&&!state.running;};
    // A logged projection alone cannot rule out a controller-private pending
    // entry. Without the live getter, issue off even when logged active=false.
    if(typeof controller?.get==='function'&&off())return;
    if(typeof controller?.set==='function')await controller.set(agent,false);
    else {
      const commands=getService('commands');
      if(typeof commands?.find!=='function'||typeof agent?.ctx?.get!=='function')throw Error('Native plan composition is not observable');
      if(commands.find(agent,'plan')===undefined&&!controller)return; // exact resolved agent has no plan-mode owner
      if(typeof commands.execute!=='function')throw Error('Native plan control is unavailable');
      const result=await commands.execute(agent,'/plan off',[],AbortSignal.timeout(30000));
      if(result?.result?.kind==='error')throw Error('Native plan-mode switch was refused');
    }
    if(!off())throw Error('Native plan-mode off is not committed');
  } catch(cause) { throw Object.assign(new Error('Cannot verify native plan mode is off; continuation was not sent'),{code:'PLAN_MODE_UNAVAILABLE',cause}); }
}
