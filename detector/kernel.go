package main

import (
    "bytes"
    "compress/gzip"
    "context"
    "crypto/rand"
    "crypto/sha256"
    "embed"
    "encoding/hex"
    "encoding/json"
    "errors"
    "io"
    "net"
    "net/http"
    "net/url"
    "os"
    "os/exec"
    "path/filepath"
    "runtime"
    "strconv"
    "sync"
    "time"
)

//go:embed embedded/* kernel-lock.json
var embeddedFiles embed.FS

type kernelLock struct {
    Repository string `json:"repository"`
    Version string `json:"version"`
    Assets map[string]struct { File string `json:"file"`; SHA256 string `json:"sha256"` } `json:"assets"`
}
func loadKernelLock() (kernelLock,error) {
    var lock kernelLock
    b,err:=embeddedFiles.ReadFile("kernel-lock.json"); if err!=nil { return lock,errors.New("kernel_missing") }
    if json.Unmarshal(b,&lock)!=nil { return lock,errors.New("kernel_failed") }
    return lock,nil
}
func extractKernel() (string,func(),error) {
    lock,err:=loadKernelLock(); if err!=nil { return "",func(){},err }
    asset,ok:=lock.Assets[runtime.GOOS+"-"+runtime.GOARCH]
    if !ok { return "",func(){},errors.New("unsupported_platform") }
    payload,err:=embeddedFiles.ReadFile("embedded/kernel.gz")
    if err!=nil { return "",func(){},errors.New("kernel_missing") }
    sum:=sha256.Sum256(payload)
    if hex.EncodeToString(sum[:])!=asset.SHA256 { return "",func(){},errors.New("kernel_checksum_failed") }
    dir,err:=os.MkdirTemp("","misub-probe-"); if err!=nil { return "",func(){},errors.New("kernel_temp_failed") }
    cleanup:=func(){ _=os.RemoveAll(dir) }
    reader,err:=gzip.NewReader(bytes.NewReader(payload)); if err!=nil { cleanup(); return "",func(){},errors.New("kernel_failed") }; defer reader.Close()
    path:=filepath.Join(dir,"mihomo")
    f,err:=os.OpenFile(path,os.O_CREATE|os.O_EXCL|os.O_WRONLY,0700)
    if err!=nil { cleanup(); return "",func(){},errors.New("kernel_temp_failed") }
    n,copyErr:=io.Copy(f,io.LimitReader(reader,128*1024*1024+1)); closeErr:=f.Close()
    if copyErr!=nil || closeErr!=nil || n>128*1024*1024 { cleanup(); return "",func(){},errors.New("kernel_failed") }
    return path,cleanup,nil
}
func newSecret() (string,error) {
    b:=make([]byte,32); if _,err:=rand.Read(b); err!=nil { return "",errors.New("random_failed") }; return hex.EncodeToString(b),nil
}
type Kernel struct {
    Client *http.Client
    transport *http.Transport
    cancel context.CancelFunc
    done chan struct{}
    dir string
    once sync.Once
}
func (k *Kernel) Close() {
    k.once.Do(func(){ k.transport.CloseIdleConnections(); k.cancel(); <-k.done; _=os.RemoveAll(k.dir) })
}
func startKernel(parent context.Context, binary string, proxy map[string]any) (*Kernel,error) {
    if binary=="" { return nil,errors.New("kernel_missing") }
    dir,err:=os.MkdirTemp(filepath.Dir(binary),"task-"); if err!=nil { return nil,errors.New("kernel_failed") }
    cleanFailure:=func(){ _=os.RemoveAll(dir) }
    l1,err:=net.Listen("tcp4","127.0.0.1:0"); if err!=nil { cleanFailure(); return nil,errors.New("kernel_failed") }
    l2,err:=net.Listen("tcp4","127.0.0.1:0"); if err!=nil { l1.Close(); cleanFailure(); return nil,errors.New("kernel_failed") }
    port:=l1.Addr().(*net.TCPAddr).Port; controller:=l2.Addr().String()
    secret,err:=newSecret(); if err!=nil { l1.Close(); l2.Close(); cleanFailure(); return nil,err }
    auth,err:=newSecret(); if err!=nil { l1.Close(); l2.Close(); cleanFailure(); return nil,err }
    cfg:=map[string]any{
        "port":port,"socks-port":0,"mixed-port":0,"redir-port":0,"tproxy-port":0,
        "allow-lan":false,"bind-address":"127.0.0.1","skip-auth-prefixes":[]string{},
        "authentication":[]string{"probe:"+auth},"mode":"rule","log-level":"silent","ipv6":true,
        "external-controller":controller,"secret":secret,"external-ui":"",
        "external-controller-cors":map[string]any{"allow-origins":[]string{},"allow-private-network":false},
        "find-process-mode":"off","geo-auto-update":false,
        "dns":map[string]any{"enable":false},"tun":map[string]any{"enable":false},
        "profile":map[string]any{"store-selected":false,"store-fake-ip":false},
        "proxies":[]any{proxy},"proxy-groups":[]any{},"rules":[]string{"MATCH,probe-target"},
    }
    encoded,err:=json.Marshal(cfg); if err!=nil { l1.Close(); l2.Close(); cleanFailure(); return nil,errors.New("invalid_format") }
    configPath:=filepath.Join(dir,"config.json")
    if os.WriteFile(configPath,encoded,0600)!=nil { l1.Close(); l2.Close(); cleanFailure(); return nil,errors.New("kernel_failed") }
    ctx,cancel:=context.WithCancel(parent)
    cmd:=exec.CommandContext(ctx,binary,"-d",dir,"-f",configPath)
    // A core error may contain a URI, credentials or provider body. Never forward its stdout/stderr.
    cmd.Stdout=io.Discard; cmd.Stderr=io.Discard
    cmd.Env=[]string{"PATH="+os.Getenv("PATH"),"HOME="+dir,"TMPDIR="+dir}
    l1.Close(); l2.Close()
    if cmd.Start()!=nil { cancel(); cleanFailure(); return nil,errors.New("kernel_failed") }
    proxyURL:=&url.URL{Scheme:"http",Host:net.JoinHostPort("127.0.0.1",strconv.Itoa(port)),User:url.UserPassword("probe",auth)}
    transport:=&http.Transport{Proxy:http.ProxyURL(proxyURL),DialContext:(&net.Dialer{Timeout:5*time.Second}).DialContext,TLSHandshakeTimeout:10*time.Second,ResponseHeaderTimeout:15*time.Second,DisableCompression:true,MaxIdleConns:2,MaxIdleConnsPerHost:1,IdleConnTimeout:5*time.Second}
    k:=&Kernel{transport:transport,cancel:cancel,done:make(chan struct{}),dir:dir}
    k.Client=&http.Client{Transport:transport,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
    go func(){ _=cmd.Wait(); close(k.done) }()
    controlTransport:=&http.Transport{Proxy:nil,DialContext:(&net.Dialer{Timeout:time.Second}).DialContext}
    control:=&http.Client{Transport:controlTransport,Timeout:time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
    defer controlTransport.CloseIdleConnections()
    deadline:=time.NewTimer(10*time.Second); defer deadline.Stop()
    tick:=time.NewTicker(100*time.Millisecond); defer tick.Stop()
    for {
        select {
        case <-parent.Done(): k.Close(); return nil,errors.New("cancelled")
        case <-k.done: k.Close(); return nil,errors.New("kernel_failed")
        case <-deadline.C: k.Close(); return nil,errors.New("kernel_failed")
        case <-tick.C:
            req,_:=http.NewRequestWithContext(ctx,"GET","http://"+controller+"/version",nil)
            req.Header.Set("Authorization","Bearer "+secret)
            resp,e:=control.Do(req)
            if e!=nil { continue }
            body,e:=io.ReadAll(io.LimitReader(resp.Body,4097)); resp.Body.Close()
            var result struct{ Version string `json:"version"` }
            if e==nil && resp.StatusCode==200 && len(body)<=4096 && json.Unmarshal(body,&result)==nil && result.Version!="" { return k,nil }
        }
    }
}
