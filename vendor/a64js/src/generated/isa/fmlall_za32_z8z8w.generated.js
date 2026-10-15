export const ENCODINGS = [
    {
        "instructionId": "fmlall_za32_z8z8w",
        "encodingId": "fmlall_za32_z8z8w_4x4",
        "mnemonic": "FMLALL",
        "className": "Four ZA quad-vectors",
        "fileName": "fmlall_za32_z8z8w.xml",
        "mask": 4293106814,
        "value": 3248554016,
        "bitCount": 23,
        "fields": [
            {
                "name": "Zm",
                "lsb": 18,
                "width": 3
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "o1",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME_F8F32"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F32",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    },
    {
        "instructionId": "fmlall_za32_z8z8w",
        "encodingId": "fmlall_za32_z8z8w_2x2",
        "mnemonic": "FMLALL",
        "className": "Two ZA quad-vectors",
        "fileName": "fmlall_za32_z8z8w.xml",
        "mask": 4292975678,
        "value": 3248488480,
        "bitCount": 21,
        "fields": [
            {
                "name": "Zm",
                "lsb": 17,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "o1",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME_F8F32"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F32",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    }
];
