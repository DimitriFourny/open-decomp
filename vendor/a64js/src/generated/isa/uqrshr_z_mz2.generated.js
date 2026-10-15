export const ENCODINGS = [
    {
        "instructionId": "uqrshr_z_mz2",
        "encodingId": "uqrshr_z_mz2_",
        "mnemonic": "UQRSHR",
        "className": "SME2",
        "fileName": "uqrshr_z_mz2.xml",
        "mask": 4293983264,
        "value": 3252737056,
        "bitCount": 19,
        "fields": [
            {
                "name": "op",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "U",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sme-two-vector-narrowing-shift"
    }
];
