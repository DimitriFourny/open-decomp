export const ENCODINGS = [
    {
        "instructionId": "aesmc_z_z",
        "encodingId": "aesmc_z_z_",
        "mnemonic": "AESMC",
        "className": "SVE2",
        "fileName": "aesmc_z_z.xml",
        "mask": 4294967264,
        "value": 1159782400,
        "bitCount": 27,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_AES"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_AES",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "aesmc-z-z"
    }
];
