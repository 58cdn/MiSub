import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NodeDetectionPanel from '../../src/components/nodes/NodeDetectionPanel.vue';
import { createI18n } from '../../src/i18n/index.js';
import { createProbeNodePreparer } from '../../functions/services/probe-node.js';
import { urlToClashProxy } from '../../functions/utils/url-to-clash.js';
const nodes = [{ id: 'a', name: 'A', url: 'trojan://fixture-one@example.com:443', enabled: true }, { id: 'b', name: 'B', url: 'trojan://fixture-two@example.com:443', enabled: false }];
const wrappers = [];
function fixture(locale='zh-CN', selected=new Set(['b'])) {
    const calls=[];
    vi.stubGlobal('fetch', vi.fn(async (url, options={})=>{
        calls.push({url,options});
        let data;
        if(url.endsWith('/capabilities')) data={storageReady:true};
        else if(url.endsWith('/agents')) data=[{id:'agent',name:'SG',lastSeen:Date.now(),revokedAt:null}];
        else if(url.endsWith('/jobs') && options.method==='GET') data=[];
        else if(url.endsWith('/format')) data={nodes:[{id:'b',name:'B',checks:{format:{status:'passed',code:'ok'}}}]};
        else data={id:'job'};
        return new Response(JSON.stringify({success:true,data}), {status:200,headers:{'Content-Type':'application/json'}});
    }));
    const w=mount(NodeDetectionPanel,{props:{nodes,selectedNodeIds:selected},global:{plugins:[createI18n({initialLocale:locale})]}});
    wrappers.push(w); return {w,calls};
}
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('node probe panel',()=>{
    it('does not fetch until opened and forwards selection intent',async()=>{
        const {w,calls}=fixture(); expect(calls).toHaveLength(0);
        await w.get('[data-testid="probe-select"]').trigger('click');expect(w.emitted('select-nodes')).toHaveLength(1);
        await w.get('[data-testid="probe-all"]').trigger('click'); await flushPromises();
        expect(w.text()).toContain('跨页，包含已禁用节点');
        expect(w.get('[data-testid="probe-submit"]').attributes('disabled')).toBeDefined();
    });
    it('only submits selected snapshots and keeps speed opt-in',async()=>{
        const {w,calls}=fixture();await w.get('[data-testid="probe-selected"]').trigger('click');await flushPromises();
        expect(w.get('[data-testid="probe-type-speed"]').element.checked).toBe(false);
        await w.get('[data-testid="probe-type-tcp"]').setValue(false);await w.get('[data-testid="probe-type-proxy"]').setValue(false);
        await w.get('[data-testid="probe-submit"]').trigger('click');await flushPromises();
        const req=calls.find(c=>c.url.endsWith('/format'));expect(req).toBeTruthy();
        expect(JSON.parse(req.options.body).nodes.map(n=>n.id)).toEqual(['b']);
        expect(w.text()).toContain('通过');
    });
    it('renders English and distinguishes all from empty selection',async()=>{
        const {w}=fixture('en-US',new Set());
        expect(w.get('[data-testid="probe-selected"]').attributes('disabled')).toBeDefined();
        expect(w.get('[data-testid="probe-all"]').attributes('disabled')).toBeUndefined();
        await w.get('[data-testid="probe-all"]').trigger('click');await flushPromises();
        expect(w.text()).toContain('All nodes across pages, including disabled nodes');expect(w.text()).toContain('Download speed');
    });
    it('prevalidates malformed credential-bearing JSON without logging parser input',async()=>{
        const log=vi.spyOn(console,'error').mockImplementation(()=>{});
        const prepare=createProbeNodePreparer(urlToClashProxy);
        const secret='fixture-secret-do-not-log';
        const bad='vmess://'+btoa('{"id":"'+secret+'",');
        const result=await prepare([{id:'bad',name:'invalid fixture',url:bad}]);
        expect(result[0].format.status).toBe('failed');expect(log).not.toHaveBeenCalled();
    });
    it('uses the production converter without returning credentials in format results',async()=>{
        const prepare=createProbeNodePreparer(urlToClashProxy);
        const prepared=await prepare(nodes);
        expect(prepared.every(n=>n.format.status==='passed')).toBe(true);
        expect(prepared[0].proxy.password).toBe('fixture-one');
        const result=prepared.map(n=>({id:n.id,checks:{format:n.format}}));expect(JSON.stringify(result)).not.toContain('fixture-one');
    });
});
