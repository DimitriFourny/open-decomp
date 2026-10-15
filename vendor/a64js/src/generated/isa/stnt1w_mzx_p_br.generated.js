export const ENCODINGS = [
    {
        "instructionId": "stnt1w_mzx_p_br",
        "encodingId": "stnt1w_mzx_p_br_4x4",
        "mnemonic": "STNT1W",
        "className": "Four registers",
        "fileName": "stnt1w_mzx_p_br.xml",
        "mask": 4292927500,
        "value": 2703278088,
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
        "instructionId": "stnt1w_mzx_p_br",
        "encodingId": "stnt1w_mzx_p_br_2x8",
        "mnemonic": "STNT1W",
        "className": "Two registers",
        "fileName": "stnt1w_mzx_p_br.xml",
        "mask": 4292927496,
        "value": 2703245320,
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
