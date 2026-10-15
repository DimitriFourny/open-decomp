export const ENCODINGS = [
    {
        "instructionId": "st1d_mzx_p_bi",
        "encodingId": "st1d_mzx_p_bi_4x4",
        "mnemonic": "ST1D",
        "className": "Four registers",
        "fileName": "st1d_mzx_p_bi.xml",
        "mask": 4293976076,
        "value": 2707480576,
        "bitCount": 17,
        "fields": [
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
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
        "instructionId": "st1d_mzx_p_bi",
        "encodingId": "st1d_mzx_p_bi_2x8",
        "mnemonic": "ST1D",
        "className": "Two registers",
        "fileName": "st1d_mzx_p_bi.xml",
        "mask": 4293976072,
        "value": 2707447808,
        "bitCount": 16,
        "fields": [
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
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
