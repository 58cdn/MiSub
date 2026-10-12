package main

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"debug/pe"
	"encoding/hex"
	"errors"
	"io"
	"strings"
)

const maxKernelBytes = 128 * 1024 * 1024

type kernelAsset struct {
	File             string `json:"file"`
	SHA256           string `json:"sha256"`
	Entry            string `json:"entry,omitempty"`
	ExecutableSHA256 string `json:"executableSha256,omitempty"`
	ExecutableBytes  uint64 `json:"executableBytes,omitempty"`
}

func decodeKernelArchive(payload []byte, asset kernelAsset) ([]byte, error) {
	fail := func() ([]byte, error) { return nil, errors.New("kernel_archive_invalid") }
	sum := sha256.Sum256(payload)
	if hex.EncodeToString(sum[:]) != asset.SHA256 {
		return nil, errors.New("kernel_checksum_failed")
	}
	if strings.HasSuffix(asset.File, ".gz") {
		reader, err := gzip.NewReader(bytes.NewReader(payload))
		if err != nil {
			return fail()
		}
		defer reader.Close()
		result, err := io.ReadAll(io.LimitReader(reader, maxKernelBytes+1))
		if err != nil || len(result) == 0 || len(result) > maxKernelBytes {
			return fail()
		}
		return result, nil
	}
	if !strings.HasSuffix(asset.File, ".zip") || asset.Entry == "" || strings.ContainsAny(asset.Entry, "\\/:") || !strings.HasSuffix(asset.Entry, ".exe") || asset.ExecutableBytes == 0 || asset.ExecutableBytes > maxKernelBytes {
		return fail()
	}
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil || len(archive.File) != 1 {
		return fail()
	}
	entry := archive.File[0]
	if entry.Name != asset.Entry || !entry.Mode().IsRegular() || entry.Flags&1 != 0 || entry.UncompressedSize64 != asset.ExecutableBytes {
		return fail()
	}
	reader, err := entry.Open()
	if err != nil {
		return fail()
	}
	defer reader.Close()
	result, err := io.ReadAll(io.LimitReader(reader, int64(asset.ExecutableBytes)+1))
	if err != nil || uint64(len(result)) != asset.ExecutableBytes {
		return fail()
	}
	sum = sha256.Sum256(result)
	if hex.EncodeToString(sum[:]) != asset.ExecutableSHA256 {
		return nil, errors.New("kernel_executable_checksum_failed")
	}
	executable, err := pe.NewFile(bytes.NewReader(result))
	if err != nil {
		return fail()
	}
	defer executable.Close()
	if _, ok := executable.OptionalHeader.(*pe.OptionalHeader64); !ok || executable.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || executable.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 || executable.Characteristics&pe.IMAGE_FILE_DLL != 0 {
		return fail()
	}
	return result, nil
}
