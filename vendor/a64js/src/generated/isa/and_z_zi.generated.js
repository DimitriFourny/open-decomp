export const ENCODINGS = [
    {
        "instructionId": "and_z_zi",
        "encodingId": "and_z_zi_",
        "mnemonic": "AND",
        "className": "SVE",
        "fileName": "and_z_zi.xml",
        "mask": 4294705152,
        "value": 92274688,
        "bitCount": 14,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm13",
                "lsb": 5,
                "width": 13
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-logical-immediate"
    }
];
