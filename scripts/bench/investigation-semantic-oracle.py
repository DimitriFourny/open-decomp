#!/usr/bin/env python3
"""Check selected public source/instruction facts in actual recorded MCP data.

This is not a blind answer score, equivalence proof, suite or target execution.
It deliberately distinguishes widened IR arithmetic from original machine width.
"""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
rows = json.loads((root / 'private/projection/functions.json').read_text())
by_name = {row['function']: {'pages': row['structured_pages'], 'native': row.get('native_disassembly'),
                           'artifact_id': row.get('artifact_id')} for row in rows}
assert set(by_name) == {'investigation_mix', 'investigation_caller', 'investigation_field',
                       'investigation_signed', 'investigation_callback'}


def details(name, kind):
    return [record['record']['details'] for page in by_name[name]['pages'] for record in page['records']
            if record['kind'] == 'inference' and record['record']['details']['kind'] == kind]


parameters = details('investigation_mix', 'parameter')
assert [(item['ordinal'], item['machine_width_bits'], item['location']['root']) for item in parameters] == [
    (0, 64, 'arm64:x0'), (1, 64, 'arm64:x1')]
call = details('investigation_caller', 'call')[0]
assert call['target']['kind'] == 'direct' and call['target']['identity']['address'] == '768'
assert call['ordered_arguments'][1]['ordinal'] == 1
assert call['ordered_arguments'][1]['constant_bits'] == '7'
assert call['ordered_arguments'][1]['width_bits'] == 64
assert call['result_width_bits'] == [64] and call['arity_complete'] is False
fields = details('investigation_field', 'field')
assert {(item['offset'], item['width_bits'], item['stride'], item['bounds']) for item in fields} == {
    ('4', 32, '16', 'unknown'), ('8', 64, '16', 'unknown')}
interpretations = details('investigation_signed', 'interpretation')
sdiv = next(item for item in interpretations if item['operation'] == 'sdiv')
assert sdiv['signed'] is True
assert sdiv['width_domain'] == 'reconstructed_ir'
trusted_instructions = (root / 'private/gold/instructions.txt').read_text()
assert '\tsdiv\tx0, x0, x1' in trusted_instructions
callback = details('investigation_callback', 'call')[0]
assert callback['target']['kind'] == 'indirect' and callback['arity_complete'] is False
assert callback['ordered_arguments'][0]['width_bits'] == 64 and callback['result_width_bits'] == [64]
linked = 0
for name, material in by_name.items():
    instructions = {page['references'][ref] for page in material['pages'] for record in page['records']
                    if record['kind'] == 'source' for ref in record['instruction_refs']}
    native = material['native']
    if native:
        native_ids = {item['id'] for item in native['data']['items']}
        artifact = json.loads((root / 'private/projection/project/artifacts' / material['artifact_id']).read_text())
        original_records = {item['id']: item for item in artifact['result']['data']['emission']['inferences']}
        assert native_ids and all(item['architecture'] == 'arm64' and item['size'] == 4
                                  for item in native['data']['items'])
        expected = {'investigation_mix': [(0x304, 'eor'), (0x308, 'add')],
                    'investigation_caller': [(0x31c, 'bl'), (0x320, 'add')],
                    'investigation_field': [(0x330, 'ldr'), (0x334, 'ldr')],
                    'investigation_signed': [(0x340, 'sdiv')],
                    'investigation_callback': [(0x350, 'mov'), (0x354, 'mov'), (0x358, 'blr'), (0x35c, 'add')]}
        for address, mnemonic in expected[name]:
            actual = next(item for item in native['data']['items'] if int(item['address']['value'], 16) == address)
            assert actual['presentation']['mnemonic'].lower() == mnemonic
    for page in material['pages']:
        assert len(page['references']) == len(set(page['references']))
        for record in page['records']:
            if record['kind'] != 'inference':
                continue
            semantic = record['record']
            for ref in semantic['instruction_refs']:
                assert 0 <= ref < len(page['references'])
            if semantic['details']['kind'] != 'parameter':
                if native:
                    assert native_ids.intersection(original_records[semantic['id']]['instruction_ids'])
                    assert semantic['instruction_refs']
                else:
                    assert any(page['references'][ref] in instructions for ref in semantic['instruction_refs'])
                linked += 1
# Paged helper contracts are renderer pseudocode semantic contracts. Compare every paged item with the
# immutable artifact's own helper list (no generated-text parsing or repair).
helper_domain = 'renderer pseudocode semantic contract; not original source or an executable helper definition'
helper_proof = {}
for name, material in by_name.items():
    emission = json.loads((root / 'private/projection/project/artifacts' / material['artifact_id']).read_text())[
        'result']['data']['emission']
    paged = [(record['artifact_helper_index'], record['name'], record['explanation'])
             for page in material['pages'] for record in page['records'] if record['kind'] == 'helper']
    assert paged == [(index, helper['name'], helper['explanation']) for index, helper in enumerate(emission['helpers'])], name
    for page in material['pages']:
        counts = page['selection']['counts']['helpers']
        assert counts == {'total': len(emission['helpers']), 'selected': len(emission['helpers'])}, name
        assert all(record['semantic_domain'] == helper_domain
                   for record in page['records'] if record['kind'] == 'helper')
    helper_proof[name] = [helper['name'] for helper in emission['helpers']]
assert any(helper_proof.values()), 'No frozen function exposed actual helper contracts'
result = {'selected_functions': len(by_name), 'source_and_instruction_assertions': 'passed',
    'instruction_linked_nonparameter_records': linked, 'target_executed': False,
    'known_constant_call_bits': '7', 'open_call_arity_preserved': True,
    'unknown_field_bounds_preserved': True,
    'signed_division_width_domains': {'machine_register_bits_gold': 64, 'ir_result_bits': sdiv['result_width_bits'],
                                    'domains_not_equated': True},
    'native_instruction_workflow': all(material['native'] is not None for material in by_name.values()),
    'helper_contracts_by_function': helper_proof, 'helper_contract_domain': helper_domain,
    'blind_answer_score': None, 'equivalence_claim': False}
(root / 'private/trusted-semantic-oracle.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
