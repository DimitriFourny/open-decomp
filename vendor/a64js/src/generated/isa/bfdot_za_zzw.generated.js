export const ENCODINGS = [
    {
        "instructionId": "bfdot_za_zzw",
        "encodingId": "bfdot_za_zzw_4x4",
        "mnemonic": "BFDOT",
        "className": "Four ZA single-vectors",
        "fileName": "bfdot_za_zzw.xml",
        "mask": 4293106808,
        "value": 3248558096,
        "bitCount": 21,
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
                "name": "opc",
                "lsb": 4,
                "width": 2
            },
            {
                "name": "off3",
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
        "operandFamilyId": "sme-dot"
    },
    {
        "instructionId": "bfdot_za_zzw",
        "encodingId": "bfdot_za_zzw_2x2",
        "mnemonic": "BFDOT",
        "className": "Two ZA single-vectors",
        "fileName": "bfdot_za_zzw.xml",
        "mask": 4292975672,
        "value": 3248492560,
        "bitCount": 19,
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
                "name": "opc",
                "lsb": 4,
                "width": 2
            },
            {
                "name": "off3",
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
        "operandFamilyId": "sme-dot"
    }
];
