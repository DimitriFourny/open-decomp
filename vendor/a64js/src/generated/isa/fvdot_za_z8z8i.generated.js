export const ENCODINGS = [
    {
        "instructionId": "fvdot_za_z8z8i",
        "encodingId": "fvdot_za_z8z8i_2xi",
        "mnemonic": "FVDOT",
        "className": "SME2",
        "fileName": "fvdot_za_z8z8i.xml",
        "mask": 4293955632,
        "value": 3251638304,
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
                "name": "op",
                "lsb": 12,
                "width": 1
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
