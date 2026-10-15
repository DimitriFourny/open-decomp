export const ENCODINGS = [
    {
        "instructionId": "fmlall_za32_z8z8i",
        "encodingId": "fmlall_za32_z8z8i_4xi",
        "mnemonic": "FMLALL",
        "className": "Four ZA quad-vectors",
        "fileName": "fmlall_za32_z8z8i.xml",
        "mask": 4293955704,
        "value": 3239084096,
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
            "FEAT_SME_F8F32"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F32",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    },
    {
        "instructionId": "fmlall_za32_z8z8i",
        "encodingId": "fmlall_za32_z8z8i_2xi",
        "mnemonic": "FMLALL",
        "className": "Two ZA quad-vectors",
        "fileName": "fmlall_za32_z8z8i.xml",
        "mask": 4293955640,
        "value": 3247439904,
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
            "FEAT_SME_F8F32"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F32",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    },
    {
        "instructionId": "fmlall_za32_z8z8i",
        "encodingId": "fmlall_za32_z8z8i_1",
        "mnemonic": "FMLALL",
        "className": "One ZA quad-vector",
        "fileName": "fmlall_za32_z8z8i.xml",
        "mask": 4293918748,
        "value": 3242196992,
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
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME_F8F32"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F32",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    }
];
