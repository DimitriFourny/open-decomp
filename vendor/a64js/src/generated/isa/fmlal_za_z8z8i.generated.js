export const ENCODINGS = [
    {
        "instructionId": "fmlal_za_z8z8i",
        "encodingId": "fmlal_za_z8z8i_4xi",
        "mnemonic": "FMLAL",
        "className": "Four ZA double-vectors",
        "fileName": "fmlal_za_z8z8i.xml",
        "mask": 4293955696,
        "value": 3247476768,
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
                "lsb": 7,
                "width": 3
            },
            {
                "name": "i4l",
                "lsb": 2,
                "width": 2
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
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
        "operandFamilyId": "sme-fp8-long-arithmetic"
    },
    {
        "instructionId": "fmlal_za_z8z8i",
        "encodingId": "fmlal_za_z8z8i_2xi",
        "mnemonic": "FMLAL",
        "className": "Two ZA double-vectors",
        "fileName": "fmlal_za_z8z8i.xml",
        "mask": 4293955632,
        "value": 3247444016,
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
                "name": "i4l",
                "lsb": 2,
                "width": 2
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
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
        "operandFamilyId": "sme-fp8-long-arithmetic"
    },
    {
        "instructionId": "fmlal_za_z8z8i",
        "encodingId": "fmlal_za_z8z8i_1",
        "mnemonic": "FMLAL",
        "className": "One ZA double-vector",
        "fileName": "fmlal_za_z8z8i.xml",
        "mask": 4293922832,
        "value": 3250585600,
        "bitCount": 14,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "i4A",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "i4B",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "i4C",
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
        "operandFamilyId": "sme-fp8-long-arithmetic"
    }
];
