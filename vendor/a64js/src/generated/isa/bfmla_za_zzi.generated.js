export const ENCODINGS = [
    {
        "instructionId": "bfmla_za_zzi",
        "encodingId": "bfmla_za_zzi_h4xi",
        "mnemonic": "BFMLA",
        "className": "Four ZA single-vectors",
        "fileName": "bfmla_za_zzi.xml",
        "mask": 4293955696,
        "value": 3239088160,
        "bitCount": 17,
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
                "name": "i3h",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "i3l",
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
        "instructionId": "bfmla_za_zzi",
        "encodingId": "bfmla_za_zzi_h2xi",
        "mnemonic": "BFMLA",
        "className": "Two ZA single-vectors",
        "fileName": "bfmla_za_zzi.xml",
        "mask": 4293955632,
        "value": 3239055392,
        "bitCount": 16,
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
                "name": "i3h",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "op",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "i3l",
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
