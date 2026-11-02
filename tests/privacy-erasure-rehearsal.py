"""Offline operational rehearsal; fabricated files only, no service API or credentials.

This models request routing and logical file removal. It does not test phone apps,
cloud backups, Firestore, secure physical erasure, or the production request desk.
"""
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def run():
    checks = []
    with tempfile.TemporaryDirectory(prefix='okclean-synthetic-erasure-') as folder:
        root = Path(folder)
        copies = [root / kind / 'SYNTHETIC-ONLY.json' for kind in
                  ('sms-export', 'photo-metadata', 'call-memo', 'linked-device', 'backup')]
        for copy in copies:
            copy.parent.mkdir()
            copy.write_text(json.dumps({'subject': 'SYNTHETIC-ONLY', 'content': 'fabricated'}))
        protected = root / 'contract-hold.json'
        protected.write_text('{"synthetic":true,"legal_basis":"UNVERIFIED-EXAMPLE"}')
        journal = []

        def process(verified, approved, hold=False, fail_at=None):
            entry = {'request_id': 'SYNTHETIC-REQ-001', 'identity_verified': verified,
                     'operator_approved': approved, 'hold_review': hold,
                     'removed': [], 'unresolved': []}
            journal.append(entry)
            if not verified or not approved or hold:
                entry['status'] = 'pending_review'
                return entry
            for copy in copies:
                # Paths are created by this harness within its private temp root.
                assert copy.resolve().is_relative_to(root.resolve())
                if copy.parent.name == fail_at:
                    entry['unresolved'].append(copy.parent.name)
                    continue
                copy.unlink(missing_ok=True)
                assert not copy.exists()
                entry['removed'].append(copy.parent.name)
            entry['status'] = 'partial' if entry['unresolved'] else 'logical_removal_verified'
            return entry

        assert process(False, True)['status'] == 'pending_review'
        assert all(p.exists() for p in copies)
        checks.append('unverified_request_does_not_delete')
        assert process(True, False)['status'] == 'pending_review'
        assert all(p.exists() for p in copies)
        checks.append('missing_operator_approval_does_not_delete')
        assert process(True, True, hold=True)['status'] == 'pending_review'
        assert all(p.exists() for p in copies)
        checks.append('unresolved_retention_hold_blocks_deletion')
        partial = process(True, True, fail_at='backup')
        assert partial['status'] == 'partial' and partial['unresolved'] == ['backup']
        assert copies[-1].exists() and protected.exists()
        checks.append('backup_failure_remains_partial')
        done = process(True, True)
        assert done['status'] == 'logical_removal_verified'
        assert all(not p.exists() for p in copies) and protected.exists()
        checks.append('approved_scope_only_and_other_record_preserved')
        # Simulated restore: the tombstone must be re-applied before reuse.
        copies[3].write_text('{"subject":"SYNTHETIC-ONLY","restored":true}')
        assert copies[3].exists()
        process(True, True)
        assert not copies[3].exists() and protected.exists()
        checks.append('restored_copy_removed_before_reuse')
        assert all('content' not in entry and 'subject' not in entry for entry in journal)
        assert journal[0]['status'] == 'pending_review' and journal[3]['status'] == 'partial'
        checks.append('minimal_audit_records_do_not_rewrite_old_outcomes')
    return {'executed_at_utc': datetime.now(timezone.utc).isoformat(),
            'scope': 'offline_synthetic_files_and_request_model_only',
            'passed': len(checks), 'checks': checks,
            'not_tested': ['native_kakao_sms_photos_calls', 'real_device_or_cloud_backup',
                           'production_firestore', 'physical_recovery_resistance',
                           'live_identity_check_or_request_notification']}


if __name__ == '__main__':
    print(json.dumps(run(), ensure_ascii=False, indent=2))
