export const ENCODINGS = [
    {
        "instructionId": "bfmmla_z16_zzz",
        "encodingId": "bfmmla_z_zzz_h",
        "mnemonic": "BFMMLA",
        "className": "SVE",
        "fileName": "bfmmla_z16_zzz.xml",
        "mask": 4292934656,
        "value": 1692459008,
        "bitCount": 17,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_B16MM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_B16MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-matrix-multiply"
    }
];
