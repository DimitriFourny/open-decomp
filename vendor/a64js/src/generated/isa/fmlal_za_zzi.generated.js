export const ENCODINGS = [
    {
        "instructionId": "fmlal_za_zzi",
        "encodingId": "fmlal_za_zzi_4xi",
        "mnemonic": "FMLAL",
        "className": "Four ZA double-vectors",
        "fileName": "fmlal_za_zzi.xml",
        "mask": 4293955704,
        "value": 3247476736,
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
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 2,
                "width": 1
            },
            {
                "name": "off2",
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
        "operandFamilyId": "sme-float-long-arithmetic"
    },
    {
        "instructionId": "fmlal_za_zzi",
        "encodingId": "fmlal_za_zzi_2xi",
        "mnemonic": "FMLAL",
        "className": "Two ZA double-vectors",
        "fileName": "fmlal_za_zzi.xml",
        "mask": 4293955640,
        "value": 3247443968,
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
                "lsb": 6,
                "width": 4
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 2,
                "width": 1
            },
            {
                "name": "off2",
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
        "operandFamilyId": "sme-float-long-arithmetic"
    },
    {
        "instructionId": "fmlal_za_zzi",
        "encodingId": "fmlal_za_zzi_1",
        "mnemonic": "FMLAL",
        "className": "One ZA double-vector",
        "fileName": "fmlal_za_zzi.xml",
        "mask": 4293922840,
        "value": 3246395392,
        "bitCount": 15,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "i3h",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "i3l",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
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
        "operandFamilyId": "sme-float-long-arithmetic"
    }
];
