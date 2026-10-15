export const ENCODINGS = [
    {
        "instructionId": "fdot_za_z8z8w",
        "encodingId": "fdot_za_z8z8w_4x4",
        "mnemonic": "FDOT",
        "className": "Four ZA single-vectors",
        "fileName": "fdot_za_z8z8w.xml",
        "mask": 4293106808,
        "value": 3248558112,
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
            "FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-dot"
    },
    {
        "instructionId": "fdot_za_z8z8w",
        "encodingId": "fdot_za_z8z8w_2x2",
        "mnemonic": "FDOT",
        "className": "Two ZA single-vectors",
        "fileName": "fdot_za_z8z8w.xml",
        "mask": 4292975672,
        "value": 3248492576,
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
            "FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-dot"
    }
];
