export const ENCODINGS = [
    {
        "instructionId": "usdot_za_zzv",
        "encodingId": "usdot_za_zzv_s2x1",
        "mnemonic": "USDOT",
        "className": "Two ZA single-vectors",
        "fileName": "usdot_za_zzv.xml",
        "mask": 4293958680,
        "value": 3240104968,
        "bitCount": 18,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
        "instructionId": "usdot_za_zzv",
        "encodingId": "usdot_za_zzv_s4x1",
        "mnemonic": "USDOT",
        "className": "Four ZA single-vectors",
        "fileName": "usdot_za_zzv.xml",
        "mask": 4293958680,
        "value": 3241153544,
        "bitCount": 18,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
