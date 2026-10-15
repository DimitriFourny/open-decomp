export const ENCODINGS = [
    {
        "instructionId": "udot_za32_zzw",
        "encodingId": "udot_za32_zzw_4x4",
        "mnemonic": "UDOT",
        "className": "Four ZA single-vectors",
        "fileName": "udot_za32_zzw.xml",
        "mask": 4293106808,
        "value": 3252753432,
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
                "name": "U",
                "lsb": 4,
                "width": 1
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
        "instructionId": "udot_za32_zzw",
        "encodingId": "udot_za32_zzw_2x2",
        "mnemonic": "UDOT",
        "className": "Two ZA single-vectors",
        "fileName": "udot_za32_zzw.xml",
        "mask": 4292975672,
        "value": 3252687896,
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
                "name": "U",
                "lsb": 4,
                "width": 1
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
