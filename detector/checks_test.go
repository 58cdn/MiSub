package main

import (
    "context"
    "io"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
    "time"
)
func TestProxyRequiresEmpty204(t *testing.T) {
    for _,status:=range []int{200,204,403,500} {
        server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(status)}))
        result:=checkProxy(context.Background(),server.Client(),server.URL,time.Second)
        server.Close()
        if (result.Status=="passed")!=(status==204) { t.Fatalf("HTTP %d classified %s",status,result.Status) }
    }
}
func TestProxyNeverTreatsConnectFailureAsSuccess(t *testing.T) {
    server:=httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter,*http.Request){})); target:=server.URL; server.Close()
    result:=checkProxy(context.Background(),server.Client(),target,100*time.Millisecond)
    if result.Status=="passed" { t.Fatal("connection failure passed") }
}
func TestSpeedBoundsConsumedPayload(t *testing.T) {
    server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){ _,_=io.Copy(w,io.LimitReader(strings.NewReader(strings.Repeat("x",1024*1024)),1024*1024)) })); defer server.Close()
    result:=checkSpeed(context.Background(),server.Client(),server.URL,time.Second,65536)
    if result.Status!="passed" || result.Bytes==nil || *result.Bytes!=65536 || result.BytesPerSecond==nil || *result.BytesPerSecond<=0 { t.Fatalf("bounded speed result: %+v",result) }
}
func TestCancellationStopsBodyReads(t *testing.T) {
    server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(200); w.(http.Flusher).Flush(); <-r.Context().Done()})); defer server.Close()
    ctx,cancel:=context.WithCancel(context.Background()); time.AfterFunc(30*time.Millisecond,cancel)
    start:=time.Now(); result:=checkSpeed(ctx,server.Client(),server.URL,time.Second,65536)
    if time.Since(start)>500*time.Millisecond || result.Status!="cancelled" { t.Fatalf("cancel not honored: %+v",result) }
}
func TestServiceEvidenceIsConservative(t *testing.T) {
    if r:=classifyService("netflix",200,[]byte("welcome"));r.Status!="unknown" || r.Code!="service_reachable" { t.Fatal("200 falsely proves unlock") }
    if r:=classifyService("openai",401,[]byte(`{"error":{"code":"invalid_api_key","type":"invalid_request_error"}}`));r.Status!="unknown" || r.Code!="service_reachable" { t.Fatal("401 misclassified") }
    if r:=classifyService("openai",403,[]byte(`{"error":{"code":"unsupported_country_region_territory"}}`));r.Status!="blocked" { t.Fatal("explicit country denial missed") }
    if r:=classifyService("youtube",200,[]byte("YouTube Premium is not available in your country"));r.Status!="blocked" { t.Fatal("explicit region message missed") }
    if r:=classifyService("youtube",403,[]byte("captcha YouTube Premium is not available in your country"));r.Status!="unknown" { t.Fatal("challenge page is not region evidence") }
    if r:=classifyService("netflix",429,nil);r.Code!="rate_limited" { t.Fatal("rate limit lost") }
}
func TestTaskValidationRejectsUnboundedAndUndeclaredWork(t *testing.T) {
    task:=Task{ID:"task-1",LeaseToken:strings.Repeat("a",64),LeaseMs:90000,Attempt:1,Types:[]string{"tcp"},Options:Options{TimeoutMs:5000,DownloadBytes:65536}}
    if err:=task.validate();err!=nil { t.Fatal(err) }
    task.Options.DownloadBytes=1<<30
    if task.validate()==nil { t.Fatal("unbounded payload accepted") }
    task.Options.DownloadBytes=65536; task.Types=[]string{"shell"}
    if task.validate()==nil { t.Fatal("undeclared task accepted") }
}
