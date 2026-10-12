package main

import (
    "context"
    "io"
    "net"
    "net/http"
    "net/http/httptest"
    "net/url"
    "os"
    "strconv"
    "sync/atomic"
    "testing"
    "time"
)
func fixtureKernel(t *testing.T) string {
    t.Helper()
    if _,err:=embeddedFiles.ReadFile("embedded/kernel.gz");err!=nil {
        if os.Getenv("MISUB_PROBE_REQUIRE_KERNEL")=="1" { t.Fatal("CI required the embedded kernel") }
        t.Skip("source-only checkout: real-kernel test runs in bundle CI")
    }
    binary,cleanup,err:=extractKernel(); if err!=nil { t.Fatal(err) }; t.Cleanup(cleanup); return binary
}
func TestEmbeddedKernelRoutesOnlyThroughNode(t *testing.T) {
    binary:=fixtureKernel(t)
    var seen atomic.Int32
    upstream:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){ seen.Add(1); _,_=io.WriteString(w,"fixture-routed-through-node") })); defer upstream.Close()
    u,_:=url.Parse(upstream.URL); host,ps,_:=net.SplitHostPort(u.Host); port,_:=strconv.Atoi(ps)
    // Fixtures call the core adapter directly; production always passes through pinProxy's public-address policy.
    proxy:=map[string]any{"name":"probe-target","type":"http","server":host,"port":port}
    ctx,cancel:=context.WithTimeout(context.Background(),20*time.Second); defer cancel()
    kernel,err:=startKernel(ctx,binary,proxy); if err!=nil { t.Fatal(err) }; defer kernel.Close()
    req,_:=http.NewRequestWithContext(ctx,"GET","http://fixture.invalid/check",nil)
    resp,err:=kernel.Client.Do(req); if err!=nil { t.Fatal("node route request failed") }; defer resp.Body.Close()
    body,_:=io.ReadAll(io.LimitReader(resp.Body,1024))
    if string(body)!="fixture-routed-through-node" || seen.Load()!=1 { t.Fatal("request did not pass through chosen proxy") }
}
func TestEmbeddedKernelDoesNotFallbackToDirect(t *testing.T) {
    binary:=fixtureKernel(t)
    var directCalls atomic.Int32
    target:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){directCalls.Add(1); w.WriteHeader(204)})); defer target.Close()
    l,err:=net.Listen("tcp4","127.0.0.1:0"); if err!=nil { t.Fatal(err) }; port:=l.Addr().(*net.TCPAddr).Port; l.Close()
    ctx,cancel:=context.WithTimeout(context.Background(),15*time.Second); defer cancel()
    kernel,err:=startKernel(ctx,binary,map[string]any{"name":"probe-target","type":"http","server":"127.0.0.1","port":port}); if err!=nil { t.Fatal(err) }; defer kernel.Close()
    result:=checkProxy(ctx,kernel.Client,target.URL,time.Second)
    if result.Status=="passed" || directCalls.Load()!=0 { t.Fatal("proxy failure fell back to direct") }
}
