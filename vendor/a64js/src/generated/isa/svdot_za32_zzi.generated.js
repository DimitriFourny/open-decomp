export const ENCODINGS = [
    {
        "instructionId": "svdot_za32_zzi",
        "encodingId": "svdot_za32_zzi_2xi",
        "mnemonic": "SVDOT",
        "className": "SME2",
        "fileName": "svdot_za32_zzi.xml",
        "mask": 4293955640,
        "value": 3243245600,
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
                "name": "op",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "i2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "U",
                "lsb": 4,
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
        "operandFamilyId": "sme-dot"
    }
];
