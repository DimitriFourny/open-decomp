export const ENCODINGS = [
    {
        "instructionId": "ld1h_mzx_p_br",
        "encodingId": "ld1h_mzx_p_br_4x4",
        "mnemonic": "LD1H",
        "className": "Four registers",
        "fileName": "ld1h_mzx_p_br.xml",
        "mask": 4292927500,
        "value": 2701172736,
        "bitCount": 16,
        "fields": [
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "PNg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "T",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "N",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    },
    {
        "instructionId": "ld1h_mzx_p_br",
        "encodingId": "ld1h_mzx_p_br_2x8",
        "mnemonic": "LD1H",
        "className": "Two registers",
        "fileName": "ld1h_mzx_p_br.xml",
        "mask": 4292927496,
        "value": 2701139968,
        "bitCount": 15,
        "fields": [
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "PNg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "T",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "N",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    }
];
