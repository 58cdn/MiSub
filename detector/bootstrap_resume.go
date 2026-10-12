package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

// A resume must use the exact executable that the private installation records.
// This compares bytes; private installation ownership is checked by the store.
func bootstrapSourceSHA256(path string) (string, error) {
	const limit = 256 * 1024 * 1024
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		return "", errors.New("resume_source_unavailable")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("resume_source_unavailable")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return "", errors.New("resume_source_changed")
	}
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(file, limit+1))
	if err != nil || size != info.Size() {
		return "", errors.New("resume_source_changed")
	}
	after, err := file.Stat()
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return "", errors.New("resume_source_changed")
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
