import copy
import gzip
import io
import json
import pathlib
import tempfile
import unittest
import zipfile
from unittest import mock

import release_gate as gate


VERSION, COMMIT, TARGET, KERNEL = '0.0.1-alpha.1', 'b' * 40, 'windows-amd64', 'v1.19.32-misub-source'


def doctor_fixture(elevated=False):
    checks = [('build', 'ok', 'build_metadata_valid'), ('platform', 'ok', 'platform_supported'),
              ('kernel_materials', 'ok', 'kernel_archive_checksum_matches'),
              ('installation', 'error' if elevated else 'info', 'installation_regular_user_required' if elevated else 'installation_not_found'),
              ('configuration', 'error', 'configuration_missing'), ('service', 'not_run', 'service_status_not_checked'),
              ('kernel_execution', 'not_run', 'kernel_execution_not_checked'), ('network', 'not_run', 'network_not_checked')]
    return {'schemaVersion': 1, 'checkedAt': '2026-10-14T12:00:00Z', 'scope': 'local_read_only', 'status': 'issues_found',
            'platform': TARGET, 'version': VERSION, 'displayVersion': VERSION, 'buildChannel': 'testing', 'sourceState': 'clean', 'revision': COMMIT, 'kernelLockVersion': KERNEL,
            'checks': [dict(id=name, state=state, code=code, **({'source': 'explicit_config'} if name == 'configuration' else {}))
                       for name, state, code in checks]}


def catalog_fixture():
    return {'schemaVersion': 1, 'distributionReady': True,
            'legacyReleases': [{'version': '0.1.0', 'tag': 'probe-v0.1.0', 'capabilities': []}],
            'release': {'version': '0.2.0', 'tag': 'probe-v0.2.0', 'capabilities': list(gate.CAPABILITIES)}}


class ReleaseCLITests(unittest.TestCase):
    def test_source_core_metadata_matches_doctor_and_archive_contract(self):
        lock = gate.source.load_lock(gate.ROOT / 'detector/source-build-lock.json')
        payload = b'Synthetic core bytes, never executed.'
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            core = root / 'fixture-core'
            core.write_bytes(payload)
            for target in gate.TARGETS:
                with self.subTest(target=target):
                    wrapper = root / target
                    (wrapper / 'detector').mkdir(parents=True)
                    generated = gate.embed_core(wrapper, core, target, lock)
                    asset = generated['assets'][target]
                    self.assertTrue(asset['file'].startswith('mihomo-' + target + '-'))
                    self.assertIn(lock['source']['version'], asset['file'])
                    extension = '.zip' if target.startswith('windows-') else '.gz'
                    archive = (wrapper / 'detector/embedded' / ('kernel' + extension)).read_bytes()
                    self.assertEqual(asset['sha256'], gate.source.digest(archive))
                    if extension == '.zip':
                        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
                            self.assertEqual(zipped.namelist(), [asset['entry']])
                            self.assertEqual(zipped.read(asset['entry']), payload)
                        self.assertEqual(asset['executableSha256'], gate.source.digest(payload))
                        self.assertEqual(asset['executableBytes'], len(payload))
                    else:
                        self.assertEqual(gzip.decompress(archive), payload)

    def test_isolation_covers_configuration_installation_and_temporary_directories(self):
        parent = {'HOME': 'real-home', 'LOCALAPPDATA': 'real-installation', 'PATH': 'trusted-tools'}
        env = gate.cli_environment(pathlib.Path('fixture-home'), parent)
        self.assertEqual(parent['HOME'], 'real-home')
        self.assertEqual(env['PATH'], 'trusted-tools')
        for name in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP'):
            self.assertEqual(env[name], 'fixture-home')

    def test_missing_configuration_is_a_precise_read_only_diagnostic(self):
        for elevated in (False, True):
            report = doctor_fixture(elevated)
            self.assertIs(gate.verify_doctor_report(report, VERSION, COMMIT, TARGET, KERNEL, elevated), report)
            with self.assertRaisesRegex(gate.GateError, 'checks_invalid'):
                gate.verify_doctor_report(report, VERSION, COMMIT, TARGET, KERNEL, not elevated)

    def test_development_cli_identity_requires_actual_sha_and_clean_source(self):
        report = doctor_fixture()
        display = VERSION + '.sha.' + COMMIT[:12]
        report.update(displayVersion=display, buildChannel='development')
        gate.verify_doctor_report(report, VERSION, COMMIT, TARGET, KERNEL, False, display, 'development')
        for change in ({'displayVersion': VERSION + '.sha.' + 'a' * 12}, {'sourceState': 'dirty'},
                       {'sourceState': 'unknown'}, {'buildChannel': 'testing'}):
            altered = dict(report, **change)
            with self.assertRaisesRegex(gate.GateError, 'display_version'):
                gate.verify_doctor_report(altered, VERSION, COMMIT, TARGET, KERNEL, False, display, 'development')

    def test_identity_and_report_shape_cannot_be_substituted(self):
        for key, value in [('version', '0.2.0'), ('revision', 'a' * 40), ('platform', 'linux-amd64'),
                           ('kernelLockVersion', 'v0.0.0'), ('scope', 'network'), ('status', 'local_checks_passed'),
                           ('schemaVersion', True), ('checkedAt', 'unknown'), ('path', 'private-path')]:
            with self.subTest(key=key), self.assertRaises(gate.GateError):
                report = doctor_fixture()
                report[key] = value
                gate.verify_doctor_report(report, VERSION, COMMIT, TARGET, KERNEL, False)

    def test_skipped_or_duplicate_checks_cannot_prove_doctor(self):
        changes = [lambda r: r['checks'].pop(), lambda r: r['checks'].__setitem__(0, r['checks'][1]),
                   lambda r: r['checks'][0].update(state='not_run'), lambda r: r['checks'][-1].update(state='ok'),
                   lambda r: r['checks'][4].update(code='configuration_valid'),
                   lambda r: r['checks'][4].update(source='working_directory'),
                   lambda r: r['checks'][0].update(token='secret')]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(gate.GateError):
                report = doctor_fixture()
                change(report)
                gate.verify_doctor_report(report, VERSION, COMMIT, TARGET, KERNEL, False)

    def test_assembly_requires_exact_version_doctor_and_no_created_files(self):
        evidence = {'schemaVersion': 2, 'buildChannel': 'testing', 'versionOutput': f'misub-probe {VERSION} ({COMMIT}); mihomo {KERNEL}',
                    'doctor': doctor_fixture(), 'doctorHomeUnchanged': True, 'installationTokenElevated': False}
        gate.verify_cli_evidence(evidence, VERSION, COMMIT, TARGET, KERNEL)
        for key, value in [('versionOutput', 'misub-probe dev'), ('doctor', None), ('doctorHomeUnchanged', False),
                           ('installationTokenElevated', 'false'), ('buildChannel', 'development'), ('schemaVersion', 1), ('schemaVersion', True)]:
            with self.subTest(key=key), self.assertRaises(gate.GateError):
                changed = copy.deepcopy(evidence)
                changed[key] = value
                gate.verify_cli_evidence(changed, VERSION, COMMIT, TARGET, KERNEL)

    def test_legacy_evidence_is_bound_to_the_published_source_identity(self):
        old_commit = '9ccee76c3cab149f34dca96c304310c9574c0d29'
        gate.verify_cli_evidence({'schemaVersion': 1}, '0.2.0', old_commit, TARGET, KERNEL)
        for version, commit in [('0.2.0', COMMIT), (VERSION, old_commit), ('0.2.1', old_commit)]:
            with self.subTest(version=version, commit=commit), self.assertRaises(gate.GateError):
                gate.verify_cli_evidence({'schemaVersion': 1}, version, commit, TARGET, KERNEL)

    def test_expected_diagnostic_exit_does_not_accept_another_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            for code, expected in ((1, 1), (0, 1), (2, 1), (1, 0)):
                path = pathlib.Path(directory) / f'{code}-{expected}.log'
                with mock.patch.object(gate.subprocess, 'run', return_value=mock.Mock(returncode=code)):
                    if code == expected:
                        self.assertEqual(gate.run(['fixture'], directory, {}, path, expected_returncode=expected), b'')
                    else:
                        with self.assertRaises(gate.GateError):
                            gate.run(['fixture'], directory, {}, path, expected_returncode=expected)

    def test_new_catalog_preserves_committed_published_release_history(self):
        catalog = catalog_fixture()
        history = gate.catalog_history(json.dumps(catalog), VERSION)
        self.assertEqual([entry['version'] for entry in history], ['0.1.0', '0.2.0'])
        self.assertEqual(history[-1]['capabilities'], gate.CAPABILITIES)
        self.assertEqual(catalog['release']['version'], '0.2.0')
        catalog['distributionReady'] = False
        self.assertEqual(gate.catalog_history(json.dumps(catalog), VERSION), history)
        self.assertFalse(catalog['distributionReady'])
        catalog['release'] = None
        self.assertEqual(gate.catalog_history(json.dumps(catalog), VERSION), history[:1])

    def test_paused_catalog_rejects_malformed_current_identity(self):
        catalog = catalog_fixture()
        catalog['distributionReady'] = False
        catalog['release']['tag'] = 'probe-v0.1.0'
        with self.assertRaisesRegex(gate.GateError, 'invalid_source_catalog'):
            gate.catalog_history(json.dumps(catalog), VERSION)

    def test_catalog_history_rejects_reuse_or_malformed_capabilities(self):
        catalog = catalog_fixture()
        changes = [lambda c: c['release'].update(version=VERSION, tag='probe-v' + VERSION),
                   lambda c: c['release'].update(capabilities=['doctor']),
                   lambda c: c['release'].update(capabilities=['pair', 'pair']),
                   lambda c: c['release'].update(tag='probe-v0.1.0'),
                   lambda c: c.update(release=None), lambda c: c.update(schemaVersion=True),
                   lambda c: c['legacyReleases'].append(c['legacyReleases'][0])]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(gate.GateError):
                changed = copy.deepcopy(catalog)
                change(changed)
                gate.catalog_history(json.dumps(changed), VERSION)

    def test_bootstrap_bytes_must_fit_the_short_loader_contract(self):
        unix = "readonly MISUB_RELEASE_VERSION=''\nreadonly MISUB_RELEASE_COMMIT=''\nreadonly MISUB_RELEASE_ASSETS=''\n"
        windows = "$MisubReleaseVersion = ''\n$MisubReleaseCommit = ''\n$MisubReleaseSize = 0\n$MisubReleaseSha256 = ''\n"
        assets = {target: {'fileName': 'misub-probe-' + target + ('.exe' if target == 'windows-amd64' else ''), 'size': 1234, 'sha256': 'c' * 64} for target in gate.TARGETS}
        for suffix in ('\0', '\r', 'x' * 65536):
            for side in ('unix', 'windows'):
                with self.subTest(side=side, suffix=repr(suffix[:4])), self.assertRaisesRegex(gate.GateError, 'script_bytes'):
                    gate.render_bootstrap(unix + (suffix if side == 'unix' else ''), windows + (suffix if side == 'windows' else ''), assets, VERSION, COMMIT)
        with self.assertRaisesRegex(gate.GateError, 'script_bytes'):
            gate.render_bootstrap('\ufeff' + unix, windows, assets, VERSION, COMMIT)


if __name__ == '__main__':
    unittest.main()
