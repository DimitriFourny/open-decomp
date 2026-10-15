export const ENCODINGS = [
    {
        "instructionId": "usmlall_za_zzi",
        "encodingId": "usmlall_za_zzi_s4xi",
        "mnemonic": "USMLALL",
        "className": "Four ZA quad-vectors",
        "fileName": "usmlall_za_zzi.xml",
        "mask": 4293955704,
        "value": 3239084064,
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
                "name": "i4h",
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
                "name": "U",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "i4l",
                "lsb": 1,
                "width": 2
            },
            {
                "name": "o1",
                "lsb": 0,
                "width": 1
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
        "operandFamilyId": "sme-long-arithmetic"
    },
    {
        "instructionId": "usmlall_za_zzi",
        "encodingId": "usmlall_za_zzi_s2xi",
        "mnemonic": "USMLALL",
        "className": "Two ZA quad-vectors",
        "fileName": "usmlall_za_zzi.xml",
        "mask": 4293955640,
        "value": 3239051296,
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
                "name": "i4h",
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
                "name": "U",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "i4l",
                "lsb": 1,
                "width": 2
            },
            {
                "name": "o1",
                "lsb": 0,
                "width": 1
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
        "operandFamilyId": "sme-long-arithmetic"
    },
    {
        "instructionId": "usmlall_za_zzi",
        "encodingId": "usmlall_za_zzi_s",
        "mnemonic": "USMLALL",
        "className": "One ZA quad-vector",
        "fileName": "usmlall_za_zzi.xml",
        "mask": 4293918748,
        "value": 3238002692,
        "bitCount": 15,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "i4h",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "i4l",
                "lsb": 10,
                "width": 3
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
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "op",
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
        "operandFamilyId": "sme-long-arithmetic"
    }
];
