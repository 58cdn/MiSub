package main

import (
    "context"
    "flag"
    "fmt"
    "os"
    "os/exec"
    "os/signal"
    "syscall"
    "time"
)
func main() {
    path:=flag.String("config","probe.json","Private configuration file downloaded from MiSub (chmod 600)")
    once:=flag.Bool("once",false,"Process at most one task, then exit")
    showVersion:=flag.Bool("version",false,"Print detector and pinned kernel versions")
    checkConfig:=flag.Bool("check-config",false,"Validate configuration without sending it anywhere")
    selfTest:=flag.Bool("self-test",false,"Verify and execute the embedded kernel version; no node or API request")
    flag.Parse()
    lock,_:=loadKernelLock()
    if *showVersion { fmt.Printf("misub-probe %s (%s); mihomo %s\n",version,commit,lock.Version); return }
    if *selfTest {
        binary,cleanup,err:=extractKernel(); if err!=nil { fmt.Fprintln(os.Stderr,"probe:",err); os.Exit(1) }; defer cleanup()
        ctx,cancel:=context.WithTimeout(context.Background(),10*time.Second); defer cancel()
        cmd:=exec.CommandContext(ctx,binary,"-v")
        if cmd.Run()!=nil { fmt.Fprintln(os.Stderr,"probe: kernel_self_test_failed"); cleanup(); os.Exit(1) }
        fmt.Println("probe: embedded_kernel_verified"); return
    }
    config,err:=readConfig(*path)
    if err!=nil { fmt.Fprintln(os.Stderr,"probe:",err); os.Exit(1) }
    if *checkConfig { fmt.Println("probe: configuration_valid"); return }
    binary,cleanup,err:=extractKernel()
    if err!=nil { fmt.Fprintln(os.Stderr,"probe:",err); os.Exit(1) }
    defer cleanup()
    ctx,stop:=signal.NotifyContext(context.Background(),os.Interrupt,syscall.SIGTERM); defer stop()
    fmt.Println("probe: started; outbound polling enabled; no public listener")
    if run(ctx,newAPI(config),binary,*once,os.Stdout)!=nil { fmt.Fprintln(os.Stderr,"probe: stopped_with_error (check enrollment, HTTPS access and task status)"); cleanup(); os.Exit(1) }
}
