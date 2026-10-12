package main

import (
    "context"
    "net/netip"
    "testing"
)
func TestPublicAddressPolicy(t *testing.T) {
    for _,s:=range []string{"0.0.0.0","10.1.2.3","100.64.0.1","127.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","192.0.2.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","255.255.255.255","::","::1","::ffff:127.0.0.1","fe80::1","fd00::1","64:ff9b::a00:1","2001:db8::1","2002:0a00:0001::1"} {
        if isPublicAddress(netip.MustParseAddr(s)) { t.Errorf("reserved address accepted: %s",s) }
    }
    for _,s:=range []string{"1.1.1.1","8.8.8.8","2606:4700:4700::1111","::ffff:1.1.1.1"} {
        if !isPublicAddress(netip.MustParseAddr(s)) { t.Errorf("public address rejected: %s",s) }
    }
}
func TestResolveRejectsRebindingMixedAnswers(t *testing.T) {
    lookup:=func(context.Context,string,string)([]netip.Addr,error){return []netip.Addr{netip.MustParseAddr("1.1.1.1"),netip.MustParseAddr("127.0.0.1")},nil}
    if _,err:=resolvePublic(context.Background(),"node.example",lookup);err==nil { t.Fatal("mixed private DNS answer accepted") }
    if _,err:=resolvePublic(context.Background(),"metadata.internal",lookup);err==nil { t.Fatal("internal DNS name accepted") }
}
func TestProxyPinPreservesSNIAndRejectsRoutes(t *testing.T) {
    lookup:=func(context.Context,string,string)([]netip.Addr,error){return []netip.Addr{netip.MustParseAddr("1.1.1.1")},nil}
    p:=map[string]any{"type":"trojan","name":"fixture","server":"node.example","port":443,"password":"fixture-only"}
    out,err:=pinProxy(context.Background(),p,lookup)
    if err!=nil { t.Fatal(err) }
    if out["server"]!="1.1.1.1" || out["sni"]!="node.example" || out["servername"]!="node.example" { t.Fatal("pin changed SNI semantics") }
    if p["server"]!="node.example" { t.Fatal("input mutated") }
    p["dialer-proxy"]="another"
    if _,err=pinProxy(context.Background(),p,lookup);err==nil { t.Fatal("secondary route accepted") }
    delete(p,"dialer-proxy"); p["skip-cert-verify"]=true
    if _,err=pinProxy(context.Background(),p,lookup);err==nil { t.Fatal("TLS verification disabled") }
}
func TestUDPProtocolsDoNotFailOnIrrelevantTCPCheck(t *testing.T) {
    for _,typ:=range []string{"hysteria","hysteria2","tuic","wireguard"} {
        if tcpSupported(map[string]any{"type":typ}) { t.Fatalf("%s TCP applicability",typ) }
    }
}
