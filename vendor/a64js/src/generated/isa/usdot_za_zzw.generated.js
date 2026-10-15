export const ENCODINGS = [
    {
        "instructionId": "usdot_za_zzw",
        "encodingId": "usdot_za_zzw_s4x4",
        "mnemonic": "USDOT",
        "className": "Four ZA single-vectors",
        "fileName": "usdot_za_zzw.xml",
        "mask": 4293106808,
        "value": 3248559112,
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
        "instructionId": "usdot_za_zzw",
        "encodingId": "usdot_za_zzw_s2x2",
        "mnemonic": "USDOT",
        "className": "Two ZA single-vectors",
        "fileName": "usdot_za_zzw.xml",
        "mask": 4292975672,
        "value": 3248493576,
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
