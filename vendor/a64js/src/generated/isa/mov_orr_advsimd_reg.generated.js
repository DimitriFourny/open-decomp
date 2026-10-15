export const ENCODINGS = [
    {
        "instructionId": "MOV_ORR_advsimd_reg",
        "encodingId": "MOV_ORR_asimdsame_only",
        "mnemonic": "ORR",
        "className": "Three registers of the same type",
        "fileName": "mov_orr_advsimd_reg.xml",
        "mask": 3219192832,
        "value": 245373952,
        "bitCount": 16,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 11,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "ORR_asimdsame_only",
        "canonicalFileName": "orr_advsimd_reg.xml",
        "operandFamilyId": "advsimd-move-register-alias"
    }
];
