export const ENCODINGS = [
    {
        "instructionId": "SMMLA_advsimd_vec",
        "encodingId": "SMMLA_asimdsame2_G",
        "mnemonic": "SMMLA",
        "className": "Vector",
        "fileName": "smmla_advsimd_vec.xml",
        "mask": 4292934656,
        "value": 1317053440,
        "bitCount": 17,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "B",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_I8MM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_I8MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-matrix-multiply-accumulate"
    }
];
