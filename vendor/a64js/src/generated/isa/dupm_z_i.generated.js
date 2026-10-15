export const ENCODINGS = [
    {
        "instructionId": "dupm_z_i",
        "encodingId": "dupm_z_i_",
        "mnemonic": "DUPM",
        "className": "SVE",
        "fileName": "dupm_z_i.xml",
        "mask": 4294705152,
        "value": 96468992,
        "bitCount": 14,
        "fields": [
            {
                "name": "imm13",
                "lsb": 5,
                "width": 13
            },
            {
                "name": "Zd",
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
        "operandFamilyId": "sve-dup-mask-immediate"
    }
];
