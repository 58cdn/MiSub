package main

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

func fixturePE() []byte {
	data := make([]byte, 512)
	copy(data, "MZ")
	binary.LittleEndian.PutUint32(data[60:], 128)
	copy(data[128:], "PE\x00\x00")
	binary.LittleEndian.PutUint16(data[132:], 0x8664)
	binary.LittleEndian.PutUint16(data[148:], 240)
	binary.LittleEndian.PutUint16(data[150:], 0x22)
	binary.LittleEndian.PutUint16(data[152:], 0x20b)
	binary.LittleEndian.PutUint32(data[260:], 16)
	return data
}
func fixtureDigest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func fixtureKernelZip(t *testing.T, exe []byte, name string, mode os.FileMode, extra bool) ([]byte, kernelAsset) {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(mode)
	file, err := archive.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write(exe); err != nil {
		t.Fatal(err)
	}
	if extra {
		entry, err := archive.Create("unexpected.txt")
		if err != nil {
			t.Fatal(err)
		}
		entry.Write([]byte("extra"))
	}
	if archive.Close() != nil {
		t.Fatal("fixture archive close")
	}
	data := output.Bytes()
	return data, kernelAsset{File: "mihomo-windows-amd64-compatible-v1.19.32.zip", SHA256: fixtureDigest(data), Entry: "mihomo-windows-amd64-compatible.exe", ExecutableSHA256: fixtureDigest(exe), ExecutableBytes: uint64(len(exe))}
}
func TestKernelZIPRejectsUntrustedArchiveAndExecutable(t *testing.T) {
	for _, scenario := range []string{"valid", "archive-checksum", "executable-checksum", "extra-entry", "traversal", "absolute", "symlink", "size", "wrong-machine", "dll", "non-pe", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			exe := fixturePE()
			name := "mihomo-windows-amd64-compatible.exe"
			mode := os.FileMode(0600)
			switch scenario {
			case "traversal":
				name = "../" + name
			case "absolute":
				name = "C:/" + name
			case "symlink":
				mode |= os.ModeSymlink
			case "wrong-machine":
				binary.LittleEndian.PutUint16(exe[132:], 0x14c)
			case "dll":
				binary.LittleEndian.PutUint16(exe[150:], 0x2022)
			case "non-pe":
				exe = []byte("fixture is not executable")
			}
			data, asset := fixtureKernelZip(t, exe, name, mode, scenario == "extra-entry")
			switch scenario {
			case "archive-checksum":
				asset.SHA256 = strings.Repeat("0", 64)
			case "executable-checksum":
				asset.ExecutableSHA256 = strings.Repeat("0", 64)
			case "size":
				asset.ExecutableBytes++
			case "truncated":
				data = data[:len(data)/2]
				asset.SHA256 = fixtureDigest(data)
			}
			decoded, err := decodeKernelArchive(data, asset)
			if scenario == "valid" {
				if err != nil || !bytes.Equal(decoded, exe) {
					t.Fatalf("valid PE rejected: %v", err)
				}
			} else if err == nil {
				t.Fatal("unsafe ZIP accepted")
			}
		})
	}
}
func TestKernelGZIPArchiveCompatibility(t *testing.T) {
	var output bytes.Buffer
	writer := gzip.NewWriter(&output)
	writer.Write([]byte("fixture kernel"))
	writer.Close()
	payload := output.Bytes()
	data, err := decodeKernelArchive(payload, kernelAsset{File: "fixture.gz", SHA256: fixtureDigest(payload)})
	if err != nil || string(data) != "fixture kernel" {
		t.Fatal("gzip compatibility failed")
	}
}
