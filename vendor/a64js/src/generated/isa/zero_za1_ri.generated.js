export const ENCODINGS = [
    {
        "instructionId": "zero_za1_ri",
        "encodingId": "zero_za1_ri_2",
        "mnemonic": "ZERO",
        "className": "Two ZA single-vectors",
        "fileName": "zero_za1_ri.xml",
        "mask": 4294942712,
        "value": 3222011904,
        "bitCount": 27,
        "fields": [
            {
                "name": "opc",
                "lsb": 15,
                "width": 3
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-zero-single-vector"
    },
    {
        "instructionId": "zero_za1_ri",
        "encodingId": "zero_za1_ri_4",
        "mnemonic": "ZERO",
        "className": "Four ZA single-vectors",
        "fileName": "zero_za1_ri.xml",
        "mask": 4294942712,
        "value": 3222142976,
        "bitCount": 27,
        "fields": [
            {
                "name": "opc",
                "lsb": 15,
                "width": 3
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-zero-single-vector"
    }
];
