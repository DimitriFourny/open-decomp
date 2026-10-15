export const ENCODINGS = [
    {
        "instructionId": "fvdott_za32_z8z8i",
        "encodingId": "fvdott_za32_z8z8i_2xi",
        "mnemonic": "FVDOTT",
        "className": "SME2",
        "fileName": "fvdott_za32_z8z8i.xml",
        "mask": 4293957680,
        "value": 3251636240,
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
                "name": "i2h",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "T",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "i2l",
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
        "operandFamilyId": "sme-dot"
    }
];
