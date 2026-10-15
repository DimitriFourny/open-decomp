export const ENCODINGS = [
    {
        "instructionId": "bfsub_za_zw",
        "encodingId": "bfsub_za_zw_4x4_16",
        "mnemonic": "BFSUB",
        "className": "Four ZA single-vectors",
        "fileName": "bfsub_za_zw.xml",
        "mask": 4294941816,
        "value": 3253017608,
        "bitCount": 24,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME_B16B16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "bfsub_za_zw",
        "encodingId": "bfsub_za_zw_2x2_16",
        "mnemonic": "BFSUB",
        "className": "Two ZA single-vectors",
        "fileName": "bfsub_za_zw.xml",
        "mask": 4294941752,
        "value": 3252952072,
        "bitCount": 23,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME_B16B16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    }
];
